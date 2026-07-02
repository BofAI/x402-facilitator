from typing import Dict
from bankofai.x402.config import NetworkConfig

to_internal_network: Dict[str, str] = {
    "tron:mainnet" : NetworkConfig.TRON_MAINNET,
    "tron:nile" : NetworkConfig.TRON_NILE,
    "tron:shasta" : NetworkConfig.TRON_SHASTA,
    "bsc:mainnet" : NetworkConfig.BSC_MAINNET,
    "bsc:testnet" : NetworkConfig.BSC_TESTNET,
    "eth:mainnet" : NetworkConfig.EVM_MAINNET,
    "eth:sepolia" : NetworkConfig.EVM_SEPOLIA,
}

def is_tron_network(network: str) -> bool:
    return network.startswith("tron:")

def is_bsc_network(network: str) -> bool:
    return network.startswith("bsc:")

def is_eth_network(network: str) -> bool:
    return network.startswith("eth:")
