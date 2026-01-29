"""
Quick test script for risk scoring system.
"""

import asyncio
import sys
from holder_analyzer import HolderAnalyzer
from dotenv import load_dotenv
import os

# Load environment
load_dotenv()
rpc_url = os.getenv("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")

async def test_holder_analysis():
    """Test holder analysis with risk scoring"""
    
    # Test token
    token_mint = "3d17dR2LMFuYyHpVi2Zu26v4WpEVQx2WBohTArYGpump"
    num_holders = 10
    
    print("\n" + "="*80)
    print("🧪 TESTING RISK SCORING SYSTEM")
    print("="*80)
    print(f"Token: {token_mint}")
    print(f"Number of holders to analyze: {num_holders}")
    print("="*80 + "\n")
    
    # Create analyzer
    analyzer = HolderAnalyzer(rpc_url)
    
    try:
        # Get holders
        print("📊 Fetching top holders...")
        holders = await analyzer.get_token_holders(token_mint, limit=num_holders)
        
        if not holders:
            print("❌ No holders found")
            return
        
        print(f"✅ Found {len(holders)} holders\n")
        
        # Analyze similarities
        print("🔍 Analyzing trading pattern similarities...")
        similarity_analysis = await analyzer.analyze_holder_similarities(holders, token_mint)
        
        # Format and display output
        output = analyzer.format_holders_output(holders, token_mint, similarity_analysis)
        print(output)
        
        # Save to file
        filename = f"holder_analysis_risk_{token_mint[:10]}.txt"
        with open(filename, 'w', encoding='utf-8') as f:
            f.write(output)
        
        print(f"\n✅ Results saved to: {filename}")
        
    except Exception as e:
        print(f"❌ Error: {str(e)}")
        import traceback
        traceback.print_exc()
    finally:
        await analyzer.close()

if __name__ == "__main__":
    asyncio.run(test_holder_analysis())
