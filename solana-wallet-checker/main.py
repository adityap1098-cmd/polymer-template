#!/usr/bin/env python3
"""
Solana Wallet Checker Bot - Main Entry Point.

A real-time Solana token transaction monitor that classifies wallets as:
- FRESH: No other token transactions except current purchase
- SEMI_NEW: Less than 5 different token transactions
- OLD: 5 or more different token transactions

Usage:
    python main.py

Environment Variables (set in .env file):
    QUICKNODE_RPC_URL: Solana RPC endpoint
    QUICKNODE_WSS_URL: Solana WebSocket endpoint
    OLD_WALLET_THRESHOLD: Number of tokens to classify as OLD (default: 5)
    POLL_INTERVAL: Polling interval in seconds (default: 5)
"""

import asyncio
import os
import sys
from datetime import datetime

from dotenv import load_dotenv
from colorama import init as colorama_init, Fore, Style

from wallet_analyzer import WalletAnalyzer, WalletType
from transaction_monitor import TransactionMonitor


# Initialize colorama for colored output
colorama_init()


def print_banner():
    """Print the program banner."""
    banner = f"""
{Fore.CYAN}╔══════════════════════════════════════════════════════════════╗
║          🔍 SOLANA WALLET CHECKER BOT 🔍                      ║
║                                                                ║
║  Real-time monitoring of token purchases                       ║
║  Classifies wallets as: FRESH | SEMI-NEW | OLD                ║
╚══════════════════════════════════════════════════════════════╝{Style.RESET_ALL}
"""
    print(banner)


def get_wallet_color(wallet_type: WalletType) -> str:
    """Get color code for wallet type."""
    colors = {
        WalletType.FRESH: Fore.GREEN,
        WalletType.SEMI_NEW: Fore.YELLOW,
        WalletType.OLD: Fore.RED
    }
    return colors.get(wallet_type, Fore.WHITE)


def print_wallet_report(wallet_info):
    """Print formatted wallet analysis report."""
    color = get_wallet_color(wallet_info.wallet_type)
    timestamp = datetime.now().strftime("%H:%M:%S")

    # Format first transaction time
    first_tx = "Unknown"
    if wallet_info.first_transaction_time:
        first_tx = wallet_info.first_transaction_time.strftime("%Y-%m-%d %H:%M:%S")

    # Format funder address (truncate for display)
    funder = wallet_info.initial_funder
    if funder:
        funder = f"{funder[:8]}...{funder[-8:]}"
    else:
        funder = "Unknown"

    # Format balance
    balance = "Unknown"
    if wallet_info.current_balance is not None:
        balance = f"{wallet_info.current_balance:.4f} SOL"

    print(f"""
{Fore.CYAN}[{timestamp}]{Style.RESET_ALL} {Fore.WHITE}NEW BUYER DETECTED{Style.RESET_ALL}
{Fore.WHITE}{'─' * 60}{Style.RESET_ALL}
{Fore.WHITE}Wallet:{Style.RESET_ALL}      {wallet_info.address[:20]}...{wallet_info.address[-10:]}
{Fore.WHITE}Status:{Style.RESET_ALL}      {color}█ {wallet_info.wallet_type.value} █{Style.RESET_ALL}
{Fore.WHITE}Unique Tokens:{Style.RESET_ALL} {wallet_info.unique_token_count} different tokens traded
{Fore.WHITE}Total Txns:{Style.RESET_ALL}   {wallet_info.total_transactions} transactions
{Fore.WHITE}First Txn:{Style.RESET_ALL}    {first_tx}
{Fore.WHITE}Funded By:{Style.RESET_ALL}    {funder}
{Fore.WHITE}SOL Balance:{Style.RESET_ALL}  {balance}
{Fore.WHITE}{'─' * 60}{Style.RESET_ALL}
""")


class WalletCheckerBot:
    """Main bot class for wallet checking."""

    def __init__(self):
        """Initialize the bot with configuration."""
        load_dotenv()

        self.rpc_url = os.getenv(
            "SOLANA_RPC_URL",
            "https://api.mainnet-beta.solana.com"
        )
        self.wss_url = os.getenv(
            "SOLANA_WSS_URL",
            "wss://api.mainnet-beta.solana.com"
        )
        self.old_threshold = int(os.getenv("OLD_WALLET_THRESHOLD", "5"))
        self.poll_interval = int(os.getenv("POLL_INTERVAL", "5"))

        self.analyzer = WalletAnalyzer(self.rpc_url, self.old_threshold)
        self.monitor = None
        self._analyzing = set()  # Track wallets being analyzed

    async def on_transaction_detected(
        self,
        buyer_wallet: str,
        signature: str,
        token_address: str
    ):
        """
        Callback when a new transaction is detected.

        Args:
            buyer_wallet: Address of the buyer wallet
            signature: Transaction signature
            token_address: Token mint address
        """
        # Skip if already analyzing this wallet
        if buyer_wallet in self._analyzing:
            return

        self._analyzing.add(buyer_wallet)

        try:
            timestamp = datetime.now().strftime("%H:%M:%S")
            print(
                f"{Fore.CYAN}[{timestamp}]{Style.RESET_ALL} "
                f"Analyzing wallet: {buyer_wallet[:20]}..."
            )

            # Analyze the wallet
            wallet_info = await self.analyzer.analyze_wallet(
                buyer_wallet,
                current_token=token_address
            )

            # Print the report
            print_wallet_report(wallet_info)

        except RuntimeError as e:
            print(f"{Fore.RED}Error analyzing wallet {buyer_wallet[:20]}...: {e}{Style.RESET_ALL}")
        finally:
            self._analyzing.discard(buyer_wallet)

    async def run(self, token_address: str, use_websocket: bool = True):
        """
        Run the bot to monitor a token.

        Args:
            token_address: Token mint address to monitor
            use_websocket: Use WebSocket (True) or polling (False)
        """
        print(f"\n{Fore.GREEN}Starting monitoring for token:{Style.RESET_ALL}")
        print(f"{Fore.WHITE}{token_address}{Style.RESET_ALL}\n")
        print(f"{Fore.YELLOW}Mode: {'WebSocket' if use_websocket else 'Polling'}{Style.RESET_ALL}")
        print(f"{Fore.YELLOW}Threshold: {self.old_threshold} tokens = OLD wallet{Style.RESET_ALL}")
        print(f"\n{Fore.CYAN}Waiting for new transactions...{Style.RESET_ALL}\n")

        self.monitor = TransactionMonitor(
            rpc_url=self.rpc_url,
            wss_url=self.wss_url,
            token_address=token_address,
            on_transaction=self.on_transaction_detected,
            poll_interval=self.poll_interval
        )

        try:
            await self.monitor.start(use_websocket=use_websocket)
        except asyncio.CancelledError:
            print(f"\n{Fore.YELLOW}Monitoring stopped.{Style.RESET_ALL}")
        finally:
            if self.monitor:
                self.monitor.stop()
                await self.monitor.close()
            await self.analyzer.close()

    def stop(self):
        """Stop the bot."""
        if self.monitor:
            self.monitor.stop()


def validate_solana_address(address: str) -> bool:
    """
    Validate a Solana address format.

    Args:
        address: Address to validate

    Returns:
        True if valid, False otherwise
    """
    import base58

    try:
        decoded = base58.b58decode(address)
        return len(decoded) == 32
    except (ValueError, TypeError):
        return False


async def main():
    """Main entry point."""
    print_banner()

    # Get token address from user
    print(f"{Fore.WHITE}Enter the token address to monitor:{Style.RESET_ALL}")
    print(f"{Fore.CYAN}(Example: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v for USDC){Style.RESET_ALL}")

    try:
        token_address = input(f"\n{Fore.GREEN}Token Address > {Style.RESET_ALL}").strip()
    except EOFError:
        print(f"\n{Fore.RED}No input provided. Exiting.{Style.RESET_ALL}")
        sys.exit(1)

    if not token_address:
        print(f"{Fore.RED}Error: Token address is required.{Style.RESET_ALL}")
        sys.exit(1)

    if not validate_solana_address(token_address):
        print(f"{Fore.RED}Error: Invalid Solana address format.{Style.RESET_ALL}")
        sys.exit(1)

    # Ask for monitoring mode
    print(f"\n{Fore.WHITE}Select monitoring mode:{Style.RESET_ALL}")
    print(f"  1. WebSocket (recommended, real-time)")
    print(f"  2. Polling (fallback, uses more requests)")

    try:
        mode_input = input(f"\n{Fore.GREEN}Mode [1/2] > {Style.RESET_ALL}").strip()
    except EOFError:
        mode_input = "1"

    use_websocket = mode_input != "2"

    # Create and run the bot
    bot = WalletCheckerBot()

    # Handle Ctrl+C gracefully
    loop = asyncio.get_event_loop()

    def signal_handler():
        print(f"\n{Fore.YELLOW}Received shutdown signal...{Style.RESET_ALL}")
        bot.stop()

    try:
        import signal
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, signal_handler)
    except (NotImplementedError, AttributeError):
        # Signal handlers not supported on Windows
        pass

    try:
        await bot.run(token_address, use_websocket=use_websocket)
    except KeyboardInterrupt:
        print(f"\n{Fore.YELLOW}Shutting down...{Style.RESET_ALL}")
        bot.stop()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print(f"\n{Fore.YELLOW}Goodbye!{Style.RESET_ALL}")
