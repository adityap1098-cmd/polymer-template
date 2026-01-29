"""
Solana Wallet Checker Bot Package.

A real-time Solana token transaction monitor that classifies wallets.
"""

from .wallet_analyzer import WalletAnalyzer, WalletInfo, WalletType
from .transaction_monitor import TransactionMonitor

__all__ = [
    "WalletAnalyzer",
    "WalletInfo",
    "WalletType",
    "TransactionMonitor",
]

__version__ = "1.0.0"
