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
from holder_analyzer import HolderAnalyzer
from csv_importer import CSVImporter


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

    # Show main menu
    print(f"{Fore.WHITE}Select operation mode:{Style.RESET_ALL}")
    print(f"  1. Monitor Real-time Token Purchases (WebSocket/Polling)")
    print(f"  2. Monitor Real-time Token Purchases (Polling only)")
    print(f"  3. Analyze Top Token Holders (RPC - limited to ~20)")
    print(f"  4. Import & Analyze from CSV (Solscan export - supports 100+) 🔥")

    try:
        main_mode = input(f"\n{Fore.GREEN}Select Mode [1/2/3/4] > {Style.RESET_ALL}").strip()
    except EOFError:
        print(f"\n{Fore.RED}No input provided. Exiting.{Style.RESET_ALL}")
        sys.exit(1)

    # Mode 4: Import from CSV
    if main_mode == "4":
        await analyze_from_csv()
        return

    # Get token address from user (for modes 1, 2, 3)
    print(f"\n{Fore.WHITE}Enter the token address:{Style.RESET_ALL}")
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

    # Mode 3: Analyze top holders
    if main_mode == "3":
        await analyze_top_holders(token_address)
        return

    # Mode 1 or 2: Real-time monitoring
    use_websocket = main_mode == "1"

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


async def analyze_top_holders(token_address: str):
    """
    Analyze top token holders.
    
    Args:
        token_address: Token mint address to analyze
    """
    load_dotenv()
    
    rpc_url = os.getenv(
        "SOLANA_RPC_URL",
        "https://api.mainnet-beta.solana.com"
    )
    
    # Ask how many holders to analyze
    print(f"\n{Fore.YELLOW}How many top holders to analyze?{Style.RESET_ALL}")
    print(f"  Recommended: 15-20 (balanced speed and coverage)")
    print(f"  ⚠️  Note: Solana RPC typically returns ~20 largest accounts (API limitation)")
    print(f"  Maximum input: 50, but actual results may be limited by Solana API")
    
    try:
        holder_input = input(f"\n{Fore.GREEN}Number of holders [default: 20] > {Style.RESET_ALL}").strip()
        if holder_input:
            holder_limit = int(holder_input)
            holder_limit = max(5, min(50, holder_limit))  # Clamp between 5-50
        else:
            holder_limit = 20  # Default: 20 holders
    except (ValueError, EOFError):
        holder_limit = 20
    
    print(f"\n{Fore.CYAN}🔍 Analyzing Top {holder_limit} Token Holders...{Style.RESET_ALL}\n")
    
    analyzer = HolderAnalyzer(rpc_url)
    
    try:
        # Get top N holders
        holders = await analyzer.get_token_holders(token_address, limit=holder_limit)
        
        if not holders:
            print(f"{Fore.RED}No holders found for this token.{Style.RESET_ALL}")
            return
        
        # Ask if user wants similarity analysis
        try:
            analyze_similarity = input(
                f"\n{Fore.YELLOW}Analyze trading pattern similarities? "
                f"(This will take longer) [y/N] > {Style.RESET_ALL}"
            ).strip().lower()
        except EOFError:
            analyze_similarity = 'n'
        
        similarity_analysis = None
        if analyze_similarity == 'y':
            # Perform similarity analysis
            similarity_analysis = await analyzer.analyze_holder_similarities(holders, token_address)
            
            if similarity_analysis["total_groups"] > 0:
                print(f"\n{Fore.GREEN}✅ Found {similarity_analysis['total_groups']} group(s) with similar trading patterns!{Style.RESET_ALL}")
            else:
                print(f"\n{Fore.YELLOW}No significant trading pattern similarities found.{Style.RESET_ALL}")
        
        # Format and print output
        output = analyzer.format_holders_output(holders, token_address, similarity_analysis)
        print(output)
        
        # Ask if user wants to save to file
        try:
            save = input(f"\n{Fore.GREEN}Save to file? [y/N] > {Style.RESET_ALL}").strip().lower()
            if save == 'y':
                filename = f"holders_{token_address[:8]}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"
                with open(filename, 'w') as f:
                    f.write(output)
                print(f"{Fore.GREEN}✅ Saved to {filename}{Style.RESET_ALL}")
        except EOFError:
            pass
        
    except RuntimeError as e:
        print(f"{Fore.RED}Error analyzing holders: {e}{Style.RESET_ALL}")
    finally:
        await analyzer.close()


async def analyze_from_csv():
    """
    Analyze token holders from imported CSV file.
    Supports Solscan CSV exports with 100+ holders.
    """
    load_dotenv()
    
    rpc_url = os.getenv(
        "SOLANA_RPC_URL",
        "https://api.mainnet-beta.solana.com"
    )
    
    print(f"\n{Fore.CYAN}📁 IMPORT & ANALYZE FROM CSV{Style.RESET_ALL}")
    print(f"{Fore.WHITE}{'=' * 60}{Style.RESET_ALL}\n")
    
    # Get file path
    print(f"{Fore.YELLOW}Enter CSV file path:{Style.RESET_ALL}")
    print(f"  Example: holders.csv")
    print(f"  Or full path: /path/to/holders.csv")
    
    try:
        csv_path = input(f"\n{Fore.GREEN}File path > {Style.RESET_ALL}").strip()
    except EOFError:
        print(f"\n{Fore.RED}No input provided. Exiting.{Style.RESET_ALL}")
        return
    
    if not csv_path:
        print(f"{Fore.RED}No file path provided.{Style.RESET_ALL}")
        return
    
    # Get token address (optional but recommended)
    print(f"\n{Fore.YELLOW}Enter token address (optional):{Style.RESET_ALL}")
    print(f"  This will be used for trading history analysis")
    
    try:
        token_address = input(f"\n{Fore.GREEN}Token address [press Enter to skip] > {Style.RESET_ALL}").strip()
    except EOFError:
        token_address = None
    
    # Import CSV
    print(f"\n{Fore.CYAN}🔍 Importing CSV...{Style.RESET_ALL}\n")
    
    importer = CSVImporter()
    
    try:
        # Validate CSV first
        validation = importer.validate_csv_format(csv_path)
        
        if not validation['valid']:
            print(f"{Fore.RED}❌ Invalid CSV format{Style.RESET_ALL}")
            if 'error' in validation:
                print(f"Error: {validation['error']}")
            else:
                print(f"Missing required columns (Address, Balance/Quantity)")
            return
        
        print(f"{Fore.GREEN}✅ CSV format valid{Style.RESET_ALL}")
        print(f"   Rows: {validation['row_count']}")
        print(f"   Columns: {', '.join(validation['headers'][:5])}...")
        
        # Parse CSV
        data = importer.parse_csv(csv_path, token_address)
        holders = data['holders']
        
        print(f"\n{Fore.GREEN}✅ Successfully imported {len(holders)} holders{Style.RESET_ALL}")
        print(f"   Total balance: {data['total_balance']:,.2f} tokens")
        
    except FileNotFoundError:
        print(f"{Fore.RED}❌ File not found: {csv_path}{Style.RESET_ALL}")
        return
    except Exception as e:
        print(f"{Fore.RED}❌ Error importing CSV: {e}{Style.RESET_ALL}")
        return
    
    # Ask if user wants similarity analysis
    print(f"\n{Fore.YELLOW}Perform trading pattern similarity analysis?{Style.RESET_ALL}")
    print(f"  This will fetch trading history for each wallet")
    print(f"  ⚠️  This may take 5-15 minutes for 100 holders")
    
    try:
        analyze_similarity = input(
            f"\n{Fore.GREEN}Analyze similarities? [y/N] > {Style.RESET_ALL}"
        ).strip().lower()
    except EOFError:
        analyze_similarity = 'n'
    
    similarity_analysis = None
    if analyze_similarity == 'y':
        if not token_address:
            print(f"\n{Fore.YELLOW}⚠️  Token address required for similarity analysis{Style.RESET_ALL}")
            try:
                token_address = input(f"{Fore.GREEN}Token address > {Style.RESET_ALL}").strip()
            except EOFError:
                token_address = None
        
        if token_address:
            analyzer = HolderAnalyzer(rpc_url)
            try:
                print(f"\n{Fore.CYAN}🔍 Analyzing trading patterns...{Style.RESET_ALL}")
                similarity_analysis = await analyzer.analyze_holder_similarities(holders, token_address)
                
                if similarity_analysis["total_groups"] > 0:
                    print(f"\n{Fore.GREEN}✅ Found {similarity_analysis['total_groups']} group(s) with similar trading patterns!{Style.RESET_ALL}")
                else:
                    print(f"\n{Fore.YELLOW}No significant trading pattern similarities found.{Style.RESET_ALL}")
            except Exception as e:
                print(f"\n{Fore.RED}Error in similarity analysis: {e}{Style.RESET_ALL}")
            finally:
                await analyzer.close()
    
    # Format and display output with risk scoring
    print(f"\n{Fore.CYAN}📊 Generating risk analysis report...{Style.RESET_ALL}\n")
    
    analyzer = HolderAnalyzer(rpc_url)
    try:
        output = analyzer.format_holders_output(holders, token_address or "Unknown", similarity_analysis)
        print(output)
        
        # Ask if user wants to save
        try:
            save = input(f"\n{Fore.GREEN}Save to file? [y/N] > {Style.RESET_ALL}").strip().lower()
            if save == 'y':
                timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
                filename = f"analysis_imported_{timestamp}.txt"
                with open(filename, 'w') as f:
                    f.write(output)
                print(f"{Fore.GREEN}✅ Saved to {filename}{Style.RESET_ALL}")
        except EOFError:
            pass
            
    finally:
        await analyzer.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print(f"\n{Fore.YELLOW}Goodbye!{Style.RESET_ALL}")
