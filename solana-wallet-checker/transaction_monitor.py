"""
Transaction Monitor Module for Solana Wallet Checker Bot.
Monitors real-time token transactions on Solana.
"""

import asyncio
import json
from datetime import datetime
from typing import Callable, Optional, Set

import aiohttp
import websockets


class TransactionMonitor:
    """Monitors Solana token transactions in real-time."""

    # Solana Token Program ID
    TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"

    def __init__(
        self,
        rpc_url: str,
        wss_url: str,
        token_address: str,
        on_transaction: Callable,
        poll_interval: int = 5
    ):
        """
        Initialize the transaction monitor.

        Args:
            rpc_url: Solana RPC endpoint URL
            wss_url: Solana WebSocket endpoint URL
            token_address: Token mint address to monitor
            on_transaction: Callback function when transaction is detected
            poll_interval: Polling interval in seconds (fallback mode)
        """
        self.rpc_url = rpc_url
        self.wss_url = wss_url
        self.token_address = token_address
        self.on_transaction = on_transaction
        self.poll_interval = poll_interval
        self._running = False
        self._processed_signatures: Set[str] = set()
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

    async def _get_signatures_for_token(self, limit: int = 20) -> list:
        """
        Get recent transaction signatures for the token.

        Args:
            limit: Maximum number of signatures to fetch

        Returns:
            List of transaction signatures
        """
        return await self._rpc_call(
            "getSignaturesForAddress",
            [self.token_address, {"limit": limit}]
        )

    async def _get_transaction(self, signature: str) -> dict:
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

    def _extract_buyer_wallets(self, transaction: dict) -> list:
        """
        Extract buyer wallet addresses from a transaction.

        Args:
            transaction: Transaction data

        Returns:
            List of buyer wallet addresses
        """
        buyers = []

        if not transaction:
            return buyers

        meta = transaction.get("meta", {})
        if not meta:
            return buyers

        # Get token balance changes
        pre_balances = meta.get("preTokenBalances", [])
        post_balances = meta.get("postTokenBalances", [])

        # Create maps for comparison
        pre_map = {}
        for bal in pre_balances:
            if bal.get("mint") == self.token_address:
                owner = bal.get("owner")
                amount = float(bal.get("uiTokenAmount", {}).get("uiAmount", 0) or 0)
                if owner:
                    pre_map[owner] = amount

        post_map = {}
        for bal in post_balances:
            if bal.get("mint") == self.token_address:
                owner = bal.get("owner")
                amount = float(bal.get("uiTokenAmount", {}).get("uiAmount", 0) or 0)
                if owner:
                    post_map[owner] = amount

        # Find wallets that increased their token balance (buyers)
        all_owners = set(pre_map.keys()) | set(post_map.keys())
        for owner in all_owners:
            pre_amount = pre_map.get(owner, 0)
            post_amount = post_map.get(owner, 0)

            if post_amount > pre_amount:
                buyers.append(owner)

        return buyers

    async def _poll_transactions(self):
        """Poll for new transactions periodically."""
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Starting transaction polling...")

        while self._running:
            try:
                signatures = await self._get_signatures_for_token(limit=20)

                for sig_info in signatures:
                    signature = sig_info.get("signature")

                    if signature in self._processed_signatures:
                        continue

                    self._processed_signatures.add(signature)

                    # Keep only last 1000 signatures in memory
                    if len(self._processed_signatures) > 1000:
                        self._processed_signatures = set(
                            list(self._processed_signatures)[-500:]
                        )

                    # Get transaction details
                    try:
                        tx = await self._get_transaction(signature)
                        if tx:
                            buyers = self._extract_buyer_wallets(tx)
                            for buyer in buyers:
                                await self.on_transaction(
                                    buyer,
                                    signature,
                                    self.token_address
                                )
                    except RuntimeError as e:
                        print(f"Error getting transaction {signature[:20]}...: {e}")

                await asyncio.sleep(self.poll_interval)

            except RuntimeError as e:
                print(f"Polling error: {e}")
                await asyncio.sleep(self.poll_interval)
            except asyncio.CancelledError:
                break

    async def _websocket_subscribe(self):
        """Subscribe to token transactions via WebSocket."""
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Connecting to WebSocket...")

        subscription_msg = json.dumps({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "logsSubscribe",
            "params": [
                {"mentions": [self.token_address]},
                {"commitment": "confirmed"}
            ]
        })

        while self._running:
            try:
                async with websockets.connect(
                    self.wss_url,
                    ping_interval=30,
                    ping_timeout=10
                ) as ws:
                    await ws.send(subscription_msg)
                    print(f"[{datetime.now().strftime('%H:%M:%S')}] WebSocket connected, monitoring token...")

                    async for message in ws:
                        if not self._running:
                            break

                        try:
                            data = json.loads(message)

                            # Handle subscription confirmation
                            if "result" in data and isinstance(data["result"], int):
                                print(f"[{datetime.now().strftime('%H:%M:%S')}] Subscription confirmed: {data['result']}")
                                continue

                            # Handle log notifications
                            if "method" in data and data["method"] == "logsNotification":
                                params = data.get("params", {})
                                result = params.get("result", {})
                                value = result.get("value", {})
                                signature = value.get("signature")

                                if signature and signature not in self._processed_signatures:
                                    self._processed_signatures.add(signature)

                                    # Get full transaction to find buyers
                                    try:
                                        tx = await self._get_transaction(signature)
                                        if tx:
                                            buyers = self._extract_buyer_wallets(tx)
                                            for buyer in buyers:
                                                await self.on_transaction(
                                                    buyer,
                                                    signature,
                                                    self.token_address
                                                )
                                    except RuntimeError as e:
                                        print(f"Error processing tx: {e}")

                        except json.JSONDecodeError:
                            continue

            except websockets.exceptions.ConnectionClosed:
                if self._running:
                    print("WebSocket disconnected, reconnecting in 5s...")
                    await asyncio.sleep(5)
            except (OSError, asyncio.TimeoutError) as e:
                if self._running:
                    print(f"WebSocket error: {e}, reconnecting in 5s...")
                    await asyncio.sleep(5)
            except asyncio.CancelledError:
                break

    async def start(self, use_websocket: bool = True):
        """
        Start monitoring transactions.

        Args:
            use_websocket: Use WebSocket (True) or polling (False)
        """
        self._running = True

        # Pre-populate processed signatures to avoid reporting old transactions
        try:
            signatures = await self._get_signatures_for_token(limit=50)
            self._processed_signatures = {
                sig.get("signature") for sig in signatures if sig.get("signature")
            }
            print(f"[{datetime.now().strftime('%H:%M:%S')}] Loaded {len(self._processed_signatures)} existing signatures")
        except RuntimeError as e:
            print(f"Warning: Could not load existing signatures: {e}")

        if use_websocket:
            await self._websocket_subscribe()
        else:
            await self._poll_transactions()

    def stop(self):
        """Stop monitoring transactions."""
        self._running = False
