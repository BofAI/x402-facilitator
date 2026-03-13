from typing import Dict

# Maps config network IDs to CAIP-2 identifiers used by the v2 SDK.
# Tron networks already use CAIP-2-style names; EVM networks need chain-ID mapping.
to_internal_network: Dict[str, str] = {
    "tron:mainnet" : "tron:mainnet",
    "tron:nile"    : "tron:nile",
    "tron:shasta"  : "tron:shasta",
    "bsc:mainnet"  : "eip155:56",
    "bsc:testnet"  : "eip155:97",
    "eth:mainnet"  : "eip155:1",
    "eth:sepolia"  : "eip155:11155111",
}

# Default RPC endpoints per network (used when config omits rpc_url / full_node).
DEFAULT_RPC_URLS: Dict[str, str] = {
    "tron:mainnet" : "https://api.trongrid.io",
    "tron:nile"    : "https://nile.trongrid.io",
    "tron:shasta"  : "https://api.shasta.trongrid.io",
    "bsc:mainnet"  : "https://bsc-dataseed1.binance.org",
    "bsc:testnet"  : "https://data-seed-prebsc-1-s1.binance.org:8545",
}

def is_tron_network(network: str) -> bool:
    return network.startswith("tron:")

def is_bsc_network(network: str) -> bool:
    return network.startswith("bsc:")

def is_eth_network(network: str) -> bool:
    return network.startswith("eth:")
