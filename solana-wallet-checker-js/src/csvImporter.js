/**
 * CSV Importer Module for Solana Wallet Checker Bot.
 * Imports holder data from Solscan CSV exports.
 * 
 * Migrated from Python to Node.js with csv-parse
 */

import { createReadStream, readFileSync } from 'fs';
import { parse } from 'csv-parse/sync';

export class CSVImporter {
  constructor() {}

  /**
   * Parse CSV file containing holder data.
   * Supports Solscan CSV format with columns: Rank, Address, Quantity, Percentage, etc.
   * 
   * @param {string} filePath - Path to CSV file
   * @param {string|null} tokenMint - Optional token mint address for metadata
   * @returns {object}
   */
  parseCSV(filePath, tokenMint = null) {
    try {
      const content = readFileSync(filePath, 'utf-8');

      // Auto-detect delimiter
      let delimiter = ',';
      const firstLine = content.split('\n')[0];
      if (firstLine.split('\t').length > firstLine.split(',').length) {
        delimiter = '\t';
      } else if (firstLine.split(';').length > firstLine.split(',').length) {
        delimiter = ';';
      }

      const records = parse(content, {
        columns: true,
        skip_empty_lines: true,
        delimiter,
        trim: true,
        relax_column_count: true,
      });

      const holders = [];
      for (const row of records) {
        const holder = this._parseRow(row);
        if (holder) holders.push(holder);
      }

      if (holders.length === 0) {
        throw new Error('No valid holder data found in CSV');
      }

      // Calculate total balance
      const totalBalance = holders.reduce((sum, h) => sum + h.balance, 0);

      // Add percentage if not present
      for (const holder of holders) {
        if (!holder.percentage || holder.percentage === 0) {
          holder.percentage = totalBalance > 0
            ? (holder.balance / totalBalance * 100)
            : 0;
        }
      }

      return {
        holders,
        totalHolders: holders.length,
        totalBalance,
        tokenMint,
        importTime: new Date().toISOString().replace('T', ' ').split('.')[0],
      };
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(`CSV file not found: ${filePath}`);
      }
      throw new Error(`Error parsing CSV: ${err.message}`);
    }
  }

  /**
   * Parse a single CSV row into holder data.
   * @param {object} row 
   * @returns {object|null}
   */
  _parseRow(row) {
    // Normalize column names (case-insensitive)
    const rowLower = {};
    for (const [key, value] of Object.entries(row)) {
      rowLower[key.toLowerCase().trim()] = (value || '').trim();
    }

    // Extract address (required)
    let address = null;
    for (const key of ['address', 'owner', 'wallet', 'account']) {
      if (rowLower[key]) {
        address = rowLower[key];
        break;
      }
    }
    if (!address || address.length < 32) return null;

    // Extract balance/quantity (required)
    let balance = 0;
    for (const key of ['quantity', 'balance', 'amount', 'tokens']) {
      if (rowLower[key]) {
        try {
          balance = parseFloat(rowLower[key].replace(/,/g, '').replace(/ /g, ''));
          if (!isNaN(balance) && balance > 0) break;
        } catch (e) {
          continue;
        }
      }
    }
    if (balance <= 0) return null;

    // Extract percentage (optional)
    let percentage = 0;
    for (const key of ['percentage', 'percent', '%', 'share']) {
      if (rowLower[key]) {
        try {
          percentage = parseFloat(rowLower[key].replace(/%/g, '').replace(/,/g, '').trim());
          if (!isNaN(percentage)) break;
        } catch (e) {
          continue;
        }
      }
    }

    // Extract rank (optional)
    let rank = null;
    for (const key of ['rank', '#', 'no', 'number']) {
      if (rowLower[key]) {
        try {
          rank = parseInt(rowLower[key], 10);
          if (!isNaN(rank)) break;
        } catch (e) {
          continue;
        }
      }
    }

    return {
      owner: address,
      balance,
      percentage: percentage || 0,
      rank,
      tokenAccount: null,
      purchaseTime: null,
      purchaseTimeStr: 'Unknown',
      tokenCount: 0,
    };
  }

  /**
   * Validate CSV file format and return info.
   * @param {string} filePath 
   * @returns {object}
   */
  validateCSVFormat(filePath) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      
      if (lines.length < 2) {
        return { valid: false, error: 'File has no data rows' };
      }

      // Parse just the header
      const records = parse(content, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
        to: 1, // Only read 1 data row to validate
      });

      const headers = Object.keys(records[0] || {});
      const headersLower = headers.map(h => h.toLowerCase());

      const hasAddress = ['address', 'owner', 'wallet', 'account'].some(k => headersLower.includes(k));
      const hasBalance = ['quantity', 'balance', 'amount', 'tokens'].some(k => headersLower.includes(k));

      return {
        valid: hasAddress && hasBalance,
        rowCount: lines.length - 1, // Exclude header
        headers,
        hasAddress,
        hasBalance,
        sample: content.slice(0, 500),
      };
    } catch (err) {
      return { valid: false, error: err.message };
    }
  }
}
