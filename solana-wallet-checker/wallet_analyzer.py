"""
Wallet Analyzer Module for Solana Wallet Checker Bot.
Analyzes wallet history and classifies wallets as OLD, SEMI-NEW, or FRESH.
"""

import asyncio
from datetime import datetime
from typing import Optional
from dataclasses import dataclass
from enum import Enum

import aiohttp


class WalletType(Enum):
    """Wallet classification types."""
    FRESH = "FRESH"      # No other token transactions except current
    SEMI_NEW = "SEMI_NEW"  # Less than 5 different token transactions
    OLD = "OLD"          # 5 or more different token transactions


@dataclass
class WalletInfo:
    """Information about a wallet."""
    address: str
    wallet_type: WalletType
    unique_token_count: int
    first_transaction_time: Optional[datetime]
    initial_funder: Optional[str]
    current_balance: Optional[float]  # Current SOL balance
    total_transactions: int


class WalletAnalyzer:
    """Analyzes Solana wallets to determine their age and activity."""

    # Solana Token Program ID
    TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    # Solana Token 2022 Program ID
    TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"

    def __init__(self, rpc_url: str, old_wallet_threshold: int = 5):
        """
        Initialize the wallet analyzer.

        Args:
            rpc_url: Solana RPC endpoint URL
            old_wallet_threshold: Number of unique tokens to classify as OLD wallet
        """
        self.rpc_url = rpc_url
        self.old_wallet_threshold = old_wallet_threshold
        self._session: Optional[aiohttp.ClientSession] = None

    async def _get_session(self) -> aiohttp.ClientSession:
        """Get or create aiohttp session."""
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        return self._session

    async def close(self):
        """Close the aiohttp session."""
        if self._session and not self._session.closed:
            await self._session.close()

    async def _rpc_call(self, method: str, params: list) -> dict:
        """
        Make an RPC call to the Solana node.

        Args:
            method: RPC method name
            params: Method parameters

        Returns:
            RPC response result
        """
        session = await self._get_session()
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params
        }

        try:
            async with session.post(self.rpc_url, json=payload) as response:
                data = await response.json()
                if "error" in data:
                    raise RuntimeError(f"RPC Error: {data['error']}")
                return data.get("result", {})
        except aiohttp.ClientError as e:
            raise RuntimeError(f"Network error: {e}") from e

    async def get_signatures_for_address(
        self, address: str, limit: int = 100
    ) -> list:
        """
        Get transaction signatures for a wallet address.

        Args:
            address: Wallet address
            limit: Maximum number of signatures to fetch

        Returns:
            List of transaction signatures
        """
        return await self._rpc_call(
            "getSignaturesForAddress",
            [address, {"limit": limit}]
        )

    async def get_transaction(self, signature: str) -> dict:
        """
        Get transaction details.

        Args:
            signature: Transaction signature

        Returns:
            Transaction details
        """
        return await self._rpc_call(
            "getTransaction",
            [signature, {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}]
        )

    async def get_token_accounts_by_owner(self, address: str) -> list:
        """
        Get all token accounts owned by a wallet.

        Args:
            address: Wallet address

        Returns:
            List of token accounts
        """
        result = await self._rpc_call(
            "getTokenAccountsByOwner",
            [
                address,
                {"programId": self.TOKEN_PROGRAM_ID},
                {"encoding": "jsonParsed"}
            ]
        )
        return result.get("value", [])

    async def _count_unique_tokens_from_transactions(
        self, address: str, current_token: Optional[str] = None
    ) -> tuple:
        """
        Count unique tokens from transaction history.

        Args:
            address: Wallet address
            current_token: Current token being bought (to exclude from count)

        Returns:
            Tuple of (unique_token_count, first_tx_time, initial_funder)
        """
        unique_tokens = set()
        first_tx_time = None
        initial_funder = None

        try:
            signatures = await self.get_signatures_for_address(address, limit=100)

            if not signatures:
                return 0, None, None

            # Get the oldest transaction (last in list) for first tx time and funder
            oldest_sig = signatures[-1] if signatures else None
            if oldest_sig:
                first_tx_time = datetime.fromtimestamp(oldest_sig.get("blockTime", 0))
                try:
                    oldest_tx = await self.get_transaction(oldest_sig["signature"])
                    if oldest_tx:
                        # Try to find the initial funder
                        meta = oldest_tx.get("meta", {})
                        if meta:
                            pre_balances = meta.get("preBalances", [])
                            post_balances = meta.get("postBalances", [])
                            account_keys = oldest_tx.get("transaction", {}).get(
                                "message", {}
                            ).get("accountKeys", [])

                            # Find who sent SOL (balance decreased)
                            for i, (pre, post) in enumerate(
                                zip(pre_balances, post_balances)
                            ):
                                if pre > post and i < len(account_keys):
                                    key = account_keys[i]
                                    funder_address = (
                                        key.get("pubkey")
                                        if isinstance(key, dict) else key
                                    )
                                    if funder_address != address:
                                        initial_funder = funder_address
                                        break
                except (RuntimeError, KeyError):
                    pass

            # Analyze recent transactions for token activity
            for sig_info in signatures[:50]:  # Check last 50 transactions
                try:
                    tx = await self.get_transaction(sig_info["signature"])
                    if not tx:
                        continue

                    # Look for token transfers in the transaction
                    meta = tx.get("meta", {})
                    if not meta:
                        continue

                    # Check pre and post token balances
                    pre_token_balances = meta.get("preTokenBalances", [])
                    post_token_balances = meta.get("postTokenBalances", [])

                    for token_balance in pre_token_balances + post_token_balances:
                        mint = token_balance.get("mint")
                        if mint and mint != current_token:
                            unique_tokens.add(mint)

                    # Also check innerInstructions for token program calls
                    inner = meta.get("innerInstructions", [])
                    for inner_group in inner:
                        for inst in inner_group.get("instructions", []):
                            if inst.get("programId") in [
                                self.TOKEN_PROGRAM_ID,
                                self.TOKEN_2022_PROGRAM_ID
                            ]:
                                parsed = inst.get("parsed", {})
                                if isinstance(parsed, dict):
                                    info = parsed.get("info", {})
                                    mint = info.get("mint")
                                    if mint and mint != current_token:
                                        unique_tokens.add(mint)

                except (RuntimeError, KeyError):
                    continue

                # Small delay to avoid rate limiting
                await asyncio.sleep(0.1)

        except RuntimeError:
            pass

        return len(unique_tokens), first_tx_time, initial_funder

    def _classify_wallet(self, unique_token_count: int) -> WalletType:
        """
        Classify wallet based on unique token count.

        Args:
            unique_token_count: Number of unique tokens traded

        Returns:
            WalletType classification
        """
        if unique_token_count == 0:
            return WalletType.FRESH
        elif unique_token_count < self.old_wallet_threshold:
            return WalletType.SEMI_NEW
        else:
            return WalletType.OLD

    async def analyze_wallet(
        self, address: str, current_token: Optional[str] = None
    ) -> WalletInfo:
        """
        Analyze a wallet and return its classification.

        Args:
            address: Wallet address to analyze
            current_token: The token being currently purchased (excluded from count)

        Returns:
            WalletInfo with classification and details
        """
        # Count unique tokens from transaction history
        unique_count, first_tx_time, initial_funder = \
            await self._count_unique_tokens_from_transactions(address, current_token)

        # Get total transaction count
        signatures = await self.get_signatures_for_address(address, limit=100)
        total_tx = len(signatures) if signatures else 0

        # Get current balance
        try:
            balance_result = await self._rpc_call("getBalance", [address])
            current_balance = balance_result.get("value", 0) / 1e9  # Convert lamports to SOL
        except RuntimeError:
            current_balance = None

        # Classify wallet
        wallet_type = self._classify_wallet(unique_count)

        return WalletInfo(
            address=address,
            wallet_type=wallet_type,
            unique_token_count=unique_count,
            first_transaction_time=first_tx_time,
            initial_funder=initial_funder,
            current_balance=current_balance,
            total_transactions=total_tx
        )
