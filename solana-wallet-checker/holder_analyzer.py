"""
Holder Analyzer Module for Solana Wallet Checker Bot.
Analyzes top token holders and their purchase history.
"""

import asyncio
from datetime import datetime
from typing import List, Dict, Optional
import aiohttp


class HolderAnalyzer:
    """Analyzes top holders of a Solana token."""

    # Known liquidity program IDs to filter out
    LIQUIDITY_PROGRAMS = {
        "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",  # Raydium AMM
        "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",  # Raydium V4
        "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",  # Raydium CLMM
        "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",   # Orca Whirlpool
        "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP",  # Orca V1
        "DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1",  # Orca V2
    }

    def __init__(self, rpc_url: str):
        """
        Initialize the holder analyzer.

        Args:
            rpc_url: Solana RPC endpoint URL
        """
        self.rpc_url = rpc_url
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

    async def get_token_holders(self, token_mint: str, limit: int = 50) -> List[Dict]:
        """
        Get top token holders for a token mint.

        Args:
            token_mint: Token mint address
            limit: Number of top holders to return (default: 50, max: 50)

        Returns:
            List of holder information dictionaries
        """
        print(f"Fetching token accounts for {token_mint}...")
        
        # Use getTokenLargestAccounts - this is the most reliable method
        # Note: Solana RPC typically returns ~20 largest accounts by default
        # This is a Solana limitation, not our code
        largest = await self._rpc_call(
            "getTokenLargestAccounts",
            [token_mint]
        )
        
        if not largest or "value" not in largest or len(largest["value"]) == 0:
            print("No token accounts found for this token")
            return []
        
        accounts = largest["value"]
        actual_count = len(accounts)
        print(f"Found {actual_count} token accounts (Solana API limit)")
        
        if limit > actual_count:
            print(f"⚠️  Note: Requested {limit} holders but Solana API only returns ~{actual_count}")
            print(f"    This is a Solana RPC limitation, not a bug in our code")
        
        # Process the accounts we got
        holders = []
        print(f"Processing account details...")
        
        for i, account_info in enumerate(accounts):
            try:
                address = account_info.get("address")
                amount = float(account_info.get("amount", 0))
                
                if not address or amount <= 0:
                    continue
                
                # Get account info to find owner
                account_data = await self._rpc_call(
                    "getAccountInfo",
                    [address, {"encoding": "jsonParsed"}]
                )
                
                if not account_data or "value" not in account_data:
                    continue
                
                parsed = account_data["value"].get("data", {}).get("parsed", {})
                info = parsed.get("info", {})
                owner = info.get("owner")
                
                if not owner:
                    continue
                
                # Skip known liquidity programs
                if owner in self.LIQUIDITY_PROGRAMS:
                    continue
                
                # Skip if owner looks like a program
                if len(owner) < 32:
                    continue
                
                # Convert amount to UI amount
                decimals = info.get("tokenAmount", {}).get("decimals", 0)
                ui_amount = amount / (10 ** decimals) if decimals > 0 else amount
                
                holders.append({
                    "owner": owner,
                    "balance": ui_amount,
                    "token_account": address
                })
                
                # Progress indicator
                if (i + 1) % 5 == 0:
                    print(f"  Processed {i + 1}/{actual_count} accounts...")
                
            except (KeyError, TypeError, ValueError, RuntimeError):
                continue
        
        if not holders:
            return []
        
        print(f"After filtering: {len(holders)} valid holders")
        
        # Sort by balance (descending)
        holders.sort(key=lambda x: x["balance"], reverse=True)
        
        # Get top N holders
        top_holders = holders[:limit]
        
        print(f"Analyzing top {len(top_holders)} holders...")
        
        # Get purchase time for each holder
        tasks = [self._get_first_purchase_time(holder["owner"], token_mint) for holder in top_holders]
        purchase_times = await asyncio.gather(*tasks, return_exceptions=True)
        
        # Add purchase time to holder info
        for holder, purchase_time in zip(top_holders, purchase_times):
            if isinstance(purchase_time, Exception):
                holder["purchase_time"] = None
                holder["purchase_time_str"] = "Unknown"
            else:
                holder["purchase_time"] = purchase_time
                if purchase_time:
                    holder["purchase_time_str"] = purchase_time.strftime("%Y-%m-%d %H:%M:%S")
                else:
                    holder["purchase_time_str"] = "Unknown"
            
            # Add default token count (will be updated if similarity analysis is run)
            if "token_count" not in holder:
                holder["token_count"] = 0
        
        return top_holders

    async def _process_largest_accounts(self, accounts: List[Dict], token_mint: str, limit: int) -> List[Dict]:
        """
        Process largest accounts from getTokenLargestAccounts result.

        Args:
            accounts: List of account info from RPC
            token_mint: Token mint address
            limit: Max number to return

        Returns:
            List of processed holder info
        """
        holders = []
        
        for account_info in accounts[:limit * 2]:  # Get more to filter liquidity
            try:
                address = account_info.get("address")
                amount = float(account_info.get("amount", 0))
                
                if not address or amount <= 0:
                    continue
                
                # Get account info to find owner
                account_data = await self._rpc_call(
                    "getAccountInfo",
                    [address, {"encoding": "jsonParsed"}]
                )
                
                if not account_data or "value" not in account_data:
                    continue
                
                parsed = account_data["value"].get("data", {}).get("parsed", {})
                info = parsed.get("info", {})
                owner = info.get("owner")
                
                if not owner:
                    continue
                
                # Skip known liquidity programs
                if owner in self.LIQUIDITY_PROGRAMS:
                    continue
                
                # Skip if owner looks like a program
                if len(owner) < 32:
                    continue
                
                # Convert amount to UI amount
                decimals = info.get("tokenAmount", {}).get("decimals", 0)
                ui_amount = amount / (10 ** decimals) if decimals > 0 else amount
                
                holders.append({
                    "owner": owner,
                    "balance": ui_amount,
                    "token_account": address
                })
                
                # Stop if we have enough holders
                if len(holders) >= limit:
                    break
                    
            except (KeyError, TypeError, ValueError, RuntimeError):
                continue
        
        if not holders:
            return []
        
        print(f"Analyzing top {len(holders)} holders...")
        
        # Get purchase time for each holder
        tasks = [self._get_first_purchase_time(holder["owner"], token_mint) for holder in holders]
        purchase_times = await asyncio.gather(*tasks, return_exceptions=True)
        
        # Add purchase time to holder info
        for holder, purchase_time in zip(holders, purchase_times):
            if isinstance(purchase_time, Exception):
                holder["purchase_time"] = None
                holder["purchase_time_str"] = "Unknown"
            else:
                holder["purchase_time"] = purchase_time
                if purchase_time:
                    holder["purchase_time_str"] = purchase_time.strftime("%Y-%m-%d %H:%M:%S")
                else:
                    holder["purchase_time_str"] = "Unknown"
            
            # Add default token count (will be updated if similarity analysis is run)
            if "token_count" not in holder:
                holder["token_count"] = 0
        
        return holders

    async def _get_wallet_token_history(self, wallet: str, exclude_token: str = None, limit: int = 50) -> set:
        """
        Get list of tokens traded by a wallet.

        Args:
            wallet: Wallet address
            exclude_token: Token to exclude from results (usually current token)
            limit: Max number of transactions to check

        Returns:
            Set of token mint addresses
        """
        try:
            # Get transaction signatures for the wallet
            signatures = await self._rpc_call(
                "getSignaturesForAddress",
                [wallet, {"limit": limit}]
            )
            
            tokens = set()
            processed = 0
            
            # Check each transaction for token interactions
            for sig_info in signatures[:limit]:
                signature = sig_info.get("signature")
                if not signature:
                    continue
                
                try:
                    # Get transaction details
                    tx = await self._rpc_call(
                        "getTransaction",
                        [
                            signature,
                            {
                                "encoding": "jsonParsed",
                                "maxSupportedTransactionVersion": 0
                            }
                        ]
                    )
                    
                    if not tx:
                        continue
                    
                    # Extract token mints from transaction metadata
                    meta = tx.get("meta", {})
                    if not meta:
                        continue
                    
                    # Check both pre and post token balances (like wallet_analyzer does)
                    pre_token_balances = meta.get("preTokenBalances", [])
                    post_token_balances = meta.get("postTokenBalances", [])
                    
                    # Combine both pre and post balances
                    all_balances = pre_token_balances + post_token_balances
                    
                    for balance in all_balances:
                        mint = balance.get("mint")
                        owner = balance.get("owner")
                        
                        # Only count if this wallet is the owner and not the excluded token
                        if mint and owner == wallet and mint != exclude_token:
                            tokens.add(mint)
                    
                    # Also check innerInstructions for token program calls
                    inner = meta.get("innerInstructions", [])
                    for inner_group in inner:
                        for inst in inner_group.get("instructions", []):
                            program_id = inst.get("programId")
                            if program_id in [
                                "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",  # Token Program
                                "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"   # Token 2022
                            ]:
                                parsed = inst.get("parsed", {})
                                if isinstance(parsed, dict):
                                    info = parsed.get("info", {})
                                    mint = info.get("mint")
                                    
                                    if mint and mint != exclude_token:
                                        # For token instructions, just add the mint
                                        # We already filtered by wallet from getSignaturesForAddress
                                        tokens.add(mint)
                    
                    processed += 1
                    
                    # Add delay to avoid rate limiting (increased for reliability)
                    if processed % 5 == 0:
                        await asyncio.sleep(0.3)
                    else:
                        await asyncio.sleep(0.05)
                
                except RuntimeError as e:
                    # Continue on error but don't stop completely
                    continue
            
            return tokens
            
        except RuntimeError:
            return set()

    async def analyze_holder_similarities(self, holders: List[Dict], current_token: str) -> Dict:
        """
        Analyze trading pattern similarities between holders.

        Args:
            holders: List of holder dictionaries
            current_token: Current token being analyzed (to exclude)

        Returns:
            Dictionary with similarity analysis
        """
        print(f"\n🔍 Analyzing trading patterns for {len(holders)} holders...")
        print("This may take a while...\n")
        
        # Get token history for each holder with progress indicator
        tasks = [
            self._get_wallet_token_history(holder["owner"], current_token)
            for holder in holders
        ]
        
        print("📊 Progress: Fetching trading history for each wallet...")
        token_histories = []
        for i, task in enumerate(tasks, 1):
            result = await task
            token_histories.append(result)
            if i % 3 == 0 or i == len(tasks):
                print(f"   [{i}/{len(tasks)}] wallets processed...")
        
        print("✅ Trading history collection complete!\n")
        
        # Add token history to holder info
        for holder, tokens in zip(holders, token_histories):
            if isinstance(tokens, Exception):
                holder["traded_tokens"] = set()
                holder["token_count"] = 0
            else:
                holder["traded_tokens"] = tokens
                holder["token_count"] = len(tokens)
        
        # Find common tokens between holders
        common_patterns = {}
        
        # Compare each pair of holders
        for i, holder1 in enumerate(holders):
            tokens1 = holder1.get("traded_tokens", set())
            if not tokens1:
                continue
            
            for j, holder2 in enumerate(holders[i+1:], i+1):
                tokens2 = holder2.get("traded_tokens", set())
                if not tokens2:
                    continue
                
                # Find common tokens
                common_tokens = tokens1 & tokens2
                
                if len(common_tokens) >= 3:  # At least 3 common tokens
                    similarity_key = frozenset([holder1["owner"], holder2["owner"]])
                    
                    if similarity_key not in common_patterns:
                        common_patterns[similarity_key] = {
                            "wallets": [holder1["owner"], holder2["owner"]],
                            "common_tokens": common_tokens,
                            "count": len(common_tokens)
                        }
        
        # Group wallets with high similarity
        wallet_groups = self._group_similar_wallets(holders, common_patterns)
        
        return {
            "holder_count": len(holders),
            "patterns": common_patterns,
            "groups": wallet_groups,
            "total_groups": len(wallet_groups)
        }

    def calculate_risk_score(self, holder: Dict, all_holders: List[Dict], similarity_analysis: Dict = None) -> Dict:
        """
        Calculate risk score for a holder based on multiple factors.
        
        Args:
            holder: Single holder dictionary with owner, balance, token_count
            all_holders: List of all holders for comparison
            similarity_analysis: Optional similarity analysis results
        
        Returns:
            Dict with score (0-100), level, and risk factors
        """
        risk_score = 0
        risk_factors = []
        
        wallet = holder['owner']
        balance = holder['balance']
        token_count = holder.get('token_count', 0)
        
        # Calculate total supply and holder percentage
        total_supply = sum(h['balance'] for h in all_holders)
        holder_percentage = (balance / total_supply * 100) if total_supply > 0 else 0
        
        # Factor 1: Token diversity (0-25 points)
        if token_count == 0:
            risk_score += 25
            risk_factors.append("❌ No trading history (25pts)")
        elif token_count <= 2:
            risk_score += 20
            risk_factors.append(f"⚠️  Low token diversity: {token_count} tokens (20pts)")
        elif token_count <= 5:
            risk_score += 10
            risk_factors.append(f"⚠️  Limited token diversity: {token_count} tokens (10pts)")
        
        # Factor 2: Holder concentration (0-30 points)
        if holder_percentage >= 10:
            points = 30
            risk_score += points
            risk_factors.append(f"🐋 Large holder: {holder_percentage:.2f}% of supply ({points}pts)")
        elif holder_percentage >= 5:
            points = 20
            risk_score += points
            risk_factors.append(f"📊 Significant holder: {holder_percentage:.2f}% ({points}pts)")
        elif holder_percentage >= 2:
            points = 10
            risk_score += points
            risk_factors.append(f"📈 Notable holder: {holder_percentage:.2f}% ({points}pts)")
        
        # Factor 3: Coordinated activity (0-30 points)
        if similarity_analysis and similarity_analysis.get("groups"):
            # Check if this wallet is in any group
            for group in similarity_analysis["groups"]:
                if wallet in group["wallets"]:
                    wallet_count = group["wallet_count"]
                    common_count = group["common_token_count"]
                    
                    if common_count >= 7 and wallet_count >= 3:
                        points = 30
                        risk_score += points
                        risk_factors.append(f"🚨 High coordination: Group of {wallet_count} wallets, {common_count} common tokens ({points}pts)")
                    elif common_count >= 5 or wallet_count >= 2:
                        points = 20
                        risk_score += points
                        risk_factors.append(f"⚠️  Moderate coordination: Group of {wallet_count} wallets, {common_count} common tokens ({points}pts)")
                    elif common_count >= 3:
                        points = 10
                        risk_score += points
                        risk_factors.append(f"ℹ️  Possible coordination: Group of {wallet_count} wallets, {common_count} common tokens ({points}pts)")
                    break
        
        # Factor 4: Suspicious patterns (0-15 points)
        # Very high or very low token count relative to balance
        if balance > 1000000 and token_count <= 1:
            risk_score += 15
            risk_factors.append("🔍 Large holder with minimal trading activity (15pts)")
        elif balance < 100 and token_count >= 10:
            risk_score += 10
            risk_factors.append("🔍 Small holder with unusually high activity (10pts)")
        
        # Determine risk level
        if risk_score >= 70:
            risk_level = "🔴 CRITICAL"
            risk_description = "High risk of manipulation/coordination"
        elif risk_score >= 50:
            risk_level = "🟠 HIGH"
            risk_description = "Significant risk indicators present"
        elif risk_score >= 30:
            risk_level = "🟡 MEDIUM"
            risk_description = "Moderate risk factors detected"
        else:
            risk_level = "🟢 LOW"
            risk_description = "Normal holder behavior"
        
        return {
            'score': risk_score,
            'level': risk_level,
            'description': risk_description,
            'factors': risk_factors,
            'holder_percentage': holder_percentage
        }

    def _group_similar_wallets(self, holders: List[Dict], patterns: Dict) -> List[Dict]:
        """
        Group wallets that have similar trading patterns.

        Args:
            holders: List of holder dictionaries
            patterns: Common trading patterns

        Returns:
            List of wallet groups
        """
        # Build adjacency map
        wallet_connections = {}
        
        for pattern_key, pattern_data in patterns.items():
            wallets = pattern_data["wallets"]
            common_count = pattern_data["count"]
            
            for wallet in wallets:
                if wallet not in wallet_connections:
                    wallet_connections[wallet] = set()
                wallet_connections[wallet].update(wallets)
                wallet_connections[wallet].discard(wallet)  # Remove self
        
        # Find connected groups (similar to finding connected components)
        visited = set()
        groups = []
        
        for wallet in wallet_connections:
            if wallet in visited:
                continue
            
            # BFS to find all connected wallets
            group = set()
            queue = [wallet]
            
            while queue:
                current = queue.pop(0)
                if current in visited:
                    continue
                
                visited.add(current)
                group.add(current)
                
                # Add connected wallets
                if current in wallet_connections:
                    for connected in wallet_connections[current]:
                        if connected not in visited:
                            queue.append(connected)
            
            if len(group) >= 2:
                # Find common tokens for this group
                group_holders = [h for h in holders if h["owner"] in group]
                common_tokens = set.intersection(*[h.get("traded_tokens", set()) for h in group_holders if h.get("traded_tokens")])
                
                groups.append({
                    "wallets": list(group),
                    "wallet_count": len(group),
                    "common_tokens": list(common_tokens)[:10],  # Top 10 common tokens
                    "common_token_count": len(common_tokens)
                })
        
        # Sort by group size
        groups.sort(key=lambda x: x["wallet_count"], reverse=True)
        
        return groups

    async def _get_first_purchase_time(self, wallet: str, token_mint: str) -> Optional[datetime]:
        """
        Get the first purchase time of a token by a wallet.

        Args:
            wallet: Wallet address
            token_mint: Token mint address

        Returns:
            DateTime of first purchase or None
        """
        try:
            # Get transaction signatures for the wallet
            signatures = await self._rpc_call(
                "getSignaturesForAddress",
                [wallet, {"limit": 1000}]  # Get up to 1000 transactions
            )
            
            # Sort by slot (ascending) to get oldest first
            signatures.sort(key=lambda x: x.get("slot", 0))
            
            # Find first transaction involving this token
            for sig_info in signatures:
                signature = sig_info.get("signature")
                block_time = sig_info.get("blockTime")
                
                if not signature:
                    continue
                
                # Get transaction details
                try:
                    tx = await self._rpc_call(
                        "getTransaction",
                        [
                            signature,
                            {
                                "encoding": "jsonParsed",
                                "maxSupportedTransactionVersion": 0
                            }
                        ]
                    )
                    
                    if not tx:
                        continue
                    
                    # Check if this transaction involves the token
                    meta = tx.get("meta", {})
                    post_balances = meta.get("postTokenBalances", [])
                    
                    for balance in post_balances:
                        if balance.get("mint") == token_mint and balance.get("owner") == wallet:
                            # This is a transaction involving the token
                            if block_time:
                                return datetime.fromtimestamp(block_time)
                            else:
                                # Use current time as fallback
                                return datetime.now()
                
                except RuntimeError:
                    continue
            
            return None
            
        except RuntimeError:
            return None

    def format_holders_output(self, holders: List[Dict], token_mint: str, similarity_analysis: Dict = None) -> str:
        """
        Format holders list for display with risk assessment.

        Args:
            holders: List of holder dictionaries
            token_mint: Token mint address
            similarity_analysis: Optional similarity analysis results

        Returns:
            Formatted string output
        """
        output = []
        output.append("\n" + "=" * 80)
        output.append(f"TOP {len(holders)} TOKEN HOLDERS - RISK ANALYSIS")
        output.append(f"Token: {token_mint}")
        output.append("=" * 80)
        output.append("")
        
        # Calculate risk scores for all holders
        for holder in holders:
            holder['risk_data'] = self.calculate_risk_score(holder, holders, similarity_analysis)
        
        # Risk summary
        risk_summary = {'🔴 CRITICAL': 0, '🟠 HIGH': 0, '🟡 MEDIUM': 0, '🟢 LOW': 0}
        for holder in holders:
            risk_summary[holder['risk_data']['level']] += 1
        
        output.append("📊 RISK SUMMARY:")
        output.append(f"   Critical Risk: {risk_summary['🔴 CRITICAL']} holders")
        output.append(f"   High Risk: {risk_summary['🟠 HIGH']} holders")
        output.append(f"   Medium Risk: {risk_summary['🟡 MEDIUM']} holders")
        output.append(f"   Low Risk: {risk_summary['🟢 LOW']} holders")
        output.append("")
        output.append("=" * 80)
        output.append("")
        
        # Sort by risk score (highest first)
        holders_sorted = sorted(holders, key=lambda h: h['risk_data']['score'], reverse=True)
        total_balance = sum(h["balance"] for h in holders)
        
        for idx, holder in enumerate(holders_sorted, 1):
            risk_data = holder['risk_data']
            percentage = (holder["balance"] / total_balance * 100) if total_balance > 0 else 0
            token_count = holder.get("token_count", 0)
            
            output.append(f"#{idx:2d} {risk_data['level']} (Score: {risk_data['score']}/100) ─────────────────────")
            output.append(f"    {risk_data['description']}")
            output.append(f"    Wallet:         {holder['owner']}")
            output.append(f"    Balance:        {holder['balance']:,.6f} tokens ({percentage:.2f}% of top {len(holders)})")
            output.append(f"    First Purchase: {holder['purchase_time_str']}")
            output.append(f"    Trading History: {token_count} different tokens traded")
            
            if risk_data['factors']:
                output.append(f"    ⚠️  Risk Factors:")
                for factor in risk_data['factors']:
                    output.append(f"       • {factor}")
            
            output.append("")
        
        output.append("=" * 80)
        output.append(f"Total Balance (Top {len(holders)}): {total_balance:,.6f} tokens")
        output.append("=" * 80)
        
        # Add similarity analysis if available
        if similarity_analysis and similarity_analysis.get("groups"):
            output.append("\n")
            output.append("🔍 " + "=" * 77)
            output.append("TRADING PATTERN SIMILARITY ANALYSIS")
            output.append("=" * 80)
            output.append("")
            output.append(f"Found {similarity_analysis['total_groups']} group(s) of wallets with similar trading patterns")
            output.append("")
            
            for group_idx, group in enumerate(similarity_analysis["groups"], 1):
                output.append(f"📊 GROUP #{group_idx} - {group['wallet_count']} Wallets")
                output.append("─" * 80)
                output.append(f"Common Tokens Traded: {group['common_token_count']} tokens")
                output.append("")
                output.append("Wallets in this group:")
                for wallet in group["wallets"]:
                    # Find holder info
                    holder_info = next((h for h in holders if h["owner"] == wallet), None)
                    if holder_info:
                        output.append(f"  • {wallet}")
                        output.append(f"    Balance: {holder_info['balance']:,.2f} tokens")
                output.append("")
                
                if group["common_tokens"]:
                    output.append("Sample Common Tokens (showing up to 10):")
                    for token in group["common_tokens"][:10]:
                        output.append(f"  • {token[:20]}...{token[-10:]}")
                output.append("")
                output.append("⚠️  Note: These wallets may be controlled by the same entity")
                output.append("    or coordinated buyers (pump groups).")
                output.append("")
            
            output.append("=" * 80)
        
        return "\n".join(output)
