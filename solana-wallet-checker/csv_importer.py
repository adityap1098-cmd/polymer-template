"""
CSV Importer Module for Solana Wallet Checker Bot.
Imports holder data from Solscan CSV exports.
"""

import csv
from typing import List, Dict, Optional
from datetime import datetime


class CSVImporter:
    """Imports and parses holder data from CSV files."""
    
    def __init__(self):
        """Initialize CSV importer."""
        pass
    
    def parse_csv(self, file_path: str, token_mint: str = None) -> Dict:
        """
        Parse CSV file containing holder data.
        
        Supports Solscan CSV format with columns:
        - Rank, Address, Quantity, Percentage, Value, etc.
        
        Args:
            file_path: Path to CSV file
            token_mint: Optional token mint address for metadata
            
        Returns:
            Dictionary with holders list and metadata
        """
        holders = []
        
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                # Try to detect CSV format
                sample = f.read(1024)
                f.seek(0)
                
                # Auto-detect delimiter
                sniffer = csv.Sniffer()
                try:
                    delimiter = sniffer.sniff(sample).delimiter
                except:
                    delimiter = ','
                
                reader = csv.DictReader(f, delimiter=delimiter)
                
                for row in reader:
                    # Parse holder data - support multiple CSV formats
                    holder = self._parse_row(row)
                    if holder:
                        holders.append(holder)
            
            if not holders:
                raise ValueError("No valid holder data found in CSV")
            
            # Calculate total balance
            total_balance = sum(h['balance'] for h in holders)
            
            # Add percentage if not present
            for holder in holders:
                if 'percentage' not in holder or holder['percentage'] == 0:
                    holder['percentage'] = (holder['balance'] / total_balance * 100) if total_balance > 0 else 0
            
            return {
                'holders': holders,
                'total_holders': len(holders),
                'total_balance': total_balance,
                'token_mint': token_mint,
                'import_time': datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            }
            
        except FileNotFoundError:
            raise FileNotFoundError(f"CSV file not found: {file_path}")
        except Exception as e:
            raise RuntimeError(f"Error parsing CSV: {e}")
    
    def _parse_row(self, row: Dict[str, str]) -> Optional[Dict]:
        """
        Parse a single CSV row into holder data.
        
        Supports multiple column name formats:
        - Solscan: "Rank", "Address", "Quantity", "Percentage"
        - Generic: "rank", "address", "balance", "amount", "percent"
        
        Args:
            row: Dictionary from CSV row
            
        Returns:
            Holder dictionary or None if invalid
        """
        # Normalize column names (case-insensitive)
        row_lower = {k.lower().strip(): v.strip() for k, v in row.items()}
        
        # Extract address (required)
        address = None
        for key in ['address', 'owner', 'wallet', 'account']:
            if key in row_lower and row_lower[key]:
                address = row_lower[key]
                break
        
        if not address or len(address) < 32:
            return None
        
        # Extract balance/quantity (required)
        balance = 0.0
        for key in ['quantity', 'balance', 'amount', 'tokens']:
            if key in row_lower and row_lower[key]:
                try:
                    # Remove commas and convert to float
                    balance_str = row_lower[key].replace(',', '').replace(' ', '')
                    balance = float(balance_str)
                    break
                except (ValueError, AttributeError):
                    continue
        
        if balance <= 0:
            return None
        
        # Extract percentage (optional)
        percentage = 0.0
        for key in ['percentage', 'percent', '%', 'share']:
            if key in row_lower and row_lower[key]:
                try:
                    # Remove % sign and convert
                    percent_str = row_lower[key].replace('%', '').replace(',', '').strip()
                    percentage = float(percent_str)
                    break
                except (ValueError, AttributeError):
                    continue
        
        # Extract rank (optional)
        rank = None
        for key in ['rank', '#', 'no', 'number']:
            if key in row_lower and row_lower[key]:
                try:
                    rank = int(row_lower[key])
                    break
                except (ValueError, AttributeError):
                    continue
        
        return {
            'owner': address,
            'balance': balance,
            'percentage': percentage,
            'rank': rank,
            'token_account': None,  # Not available from CSV
            'purchase_time': None,
            'purchase_time_str': 'Unknown',
            'token_count': 0  # Will be filled by similarity analysis
        }
    
    def validate_csv_format(self, file_path: str) -> Dict[str, any]:
        """
        Validate CSV file format and return info.
        
        Args:
            file_path: Path to CSV file
            
        Returns:
            Dictionary with validation results
        """
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                # Read first few lines
                sample = f.read(2048)
                f.seek(0)
                
                reader = csv.DictReader(f)
                headers = reader.fieldnames
                
                # Count rows
                row_count = sum(1 for _ in reader)
                
                # Check for required columns
                headers_lower = [h.lower() for h in headers]
                has_address = any(k in headers_lower for k in ['address', 'owner', 'wallet', 'account'])
                has_balance = any(k in headers_lower for k in ['quantity', 'balance', 'amount', 'tokens'])
                
                return {
                    'valid': has_address and has_balance,
                    'row_count': row_count,
                    'headers': headers,
                    'has_address': has_address,
                    'has_balance': has_balance,
                    'sample': sample[:500]
                }
                
        except Exception as e:
            return {
                'valid': False,
                'error': str(e)
            }
