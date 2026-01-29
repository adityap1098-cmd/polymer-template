# CSV Format Guide for Import

## Solscan CSV Format (Recommended)

Bot ini sudah dioptimalkan untuk format CSV export dari Solscan.

### Format Columns:
```
Account,Token Acct,Quantity,Percentage
```

### Column Details:
- **Account**: Wallet address holder (required)
- **Token Acct**: Token account address (optional, not used)
- **Quantity**: Jumlah token yang dipegang (required)
- **Percentage**: Persentase kepemilikan (optional, akan dihitung otomatis)

### Example CSV:
```csv
Account,Token Acct,Quantity,Percentage
2oKxCbjR6nJMf8JWuDyV...,2029665831,263927944.4,20.3
F5bNmgmFFCqbSMBmMaNE...,2280755279,22550940.17,2.58
2NxsrGQtXNr3LSWRt3bD...,2255094017,22550940.17,2.26
```

## How to Export from Solscan

### Step-by-step:
1. Buka https://solscan.io/
2. Search token address di search bar
3. Klik tab **"Holders"**
4. Klik tombol **"Export"** di kanan atas
5. Download file CSV
6. Save file di folder `solana-wallet-checker/`

### Tips:
- File biasanya bernama seperti `holders-[token-address].csv`
- Rename file untuk kemudahan: `holders.csv`
- Pastikan format CSV tetap original (jangan edit di Excel)

## Alternative CSV Formats Supported

Bot juga support format CSV generic dengan nama kolom yang berbeda:

### Supported Column Names:

**For Address:**
- `Account` (Solscan)
- `Address`
- `Owner`
- `Wallet`

**For Balance:**
- `Quantity` (Solscan)
- `Balance`
- `Amount`
- `Tokens`

**For Percentage:**
- `Percentage` (Solscan)
- `Percent`
- `%`
- `Share`

### Example Alternative Format:
```csv
Address,Balance,Percentage
2oKxCbjR6nJMf...,263927944.4,20.3
F5bNmgmFFCqb...,22550940.17,2.58
```

## Number Format

Bot support berbagai format angka:
- `263927944.4` ✅
- `263,927,944.4` ✅
- `263 927 944.4` ✅
- `20.3%` ✅ (akan remove % sign)
- `20.3` ✅

## Validation

Bot akan automatically:
- ✅ Validate CSV format sebelum import
- ✅ Check required columns (Address & Balance)
- ✅ Count jumlah rows
- ✅ Display preview dari data

## Common Issues

### Issue 1: "Invalid CSV format"
**Solution**: Pastikan CSV punya kolom `Account` atau `Address` dan `Quantity` atau `Balance`

### Issue 2: "No valid holder data found"
**Solution**: 
- Check wallet addresses minimal 32 characters
- Check balance tidak 0 atau negative

### Issue 3: "File not found"
**Solution**: 
- Pastikan path file benar
- Jika file di current directory, cukup nama file saja: `holders.csv`
- Jika di folder lain, gunakan full path: `/path/to/holders.csv`

## Best Practices

1. **File Naming**: Gunakan nama yang descriptive
   - ✅ `holders_tokenname_20260129.csv`
   - ❌ `download.csv`

2. **Backup**: Save original CSV dari Solscan
   
3. **Multiple Tokens**: Buat folder terpisah per token untuk organization

4. **File Size**: Bot bisa handle 100+ holders, tested hingga 1000+ rows

5. **Encoding**: Pastikan UTF-8 encoding (default dari Solscan)

## Example Usage

```bash
# 1. Download CSV from Solscan
# 2. Save to solana-wallet-checker folder
# 3. Run bot
python main.py

# 4. Select Option 4
Select Mode [1/2/3/4] > 4

# 5. Input file path
File path > holders.csv

# 6. (Optional) Input token address for similarity analysis
Token address > [your-token-address]

# 7. Choose similarity analysis
Analyze similarities? [y/N] > n

# 8. View comprehensive risk report!
```

## Sample Files

Bot includes `example_holders.csv` dengan real Solscan format untuk testing.

```bash
# Test dengan example file
python main.py
# Select: 4
# File: example_holders.csv
```

## Support

Format CSV yang didukung sangat flexible. Jika punya format berbeda dan tidak berfungsi, silakan report issue dengan sample CSV (tanpa sensitive data).
