"""
Facilitator Main Entry Point
Starts a FastAPI server for facilitator operations with full payment flow support.
"""

import logging
import asyncio
import os
from contextlib import asynccontextmanager
from helper import (
    to_internal_network,
    is_tron_network,
    is_bsc_network,
    is_eth_network,
)
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from bankofai.x402.mechanisms.tron.exact_permit.facilitator import ExactPermitTronFacilitatorMechanism
from bankofai.x402.mechanisms.evm.exact_permit.facilitator import ExactPermitEvmFacilitatorMechanism
from bankofai.x402.mechanisms.tron.exact.facilitator import ExactTronFacilitatorMechanism
from bankofai.x402.mechanisms.evm.exact.facilitator import ExactEvmFacilitatorMechanism
from bankofai.x402.mechanisms.tron.exact_gasfree.facilitator import ExactGasFreeFacilitatorMechanism
from bankofai.x402.utils.gasfree import GasFreeAPIClient
from bankofai.x402.signers.facilitator import TronFacilitatorSigner, EvmFacilitatorSigner
from bankofai.x402.facilitator.x402_facilitator import X402Facilitator
from bankofai.x402.config import NetworkConfig
from bankofai.x402.types import (
    VerifyResponse,
    SettleResponse,
)
from config import config
from database import (
    init_database,
    dispose_engine,
    get_payment_by_id,
    get_payment_by_tx_hash,
    save_payment_record,
    get_api_key_by_key,
)
from logging_setup import setup_logging
from schemas import VerifyRequest, SettleRequest, FeeQuoteRequest, PaymentRecordResponse
from auth import setup_auth, api_key_refresher, limiter, get_dynamic_rate_limit, get_dynamic_key_func
from monitoring import attach_prometheus_middleware

# Setup initial logging (console only)
setup_logging()
logger = logging.getLogger(__name__)

# Global facilitator instance
x402_facilitator = X402Facilitator()

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager"""
    # Startup
    logger.info("Initializing application...")
    
    # Load configuration
    config.load_from_yaml()
    logger.info("Configuration loaded")
    
    # Re-setup logging with configuration (file logging)
    setup_logging(config.logging_config)
    logger.info("Logging configured with file output")
    
    # Configure monitoring (now that config is loaded)
    from monitoring import start_monitoring_server
    start_monitoring_server(instrumentator, app, config)
    
    # Initialize database (URL may include password from 1Password)
    database_url = await config.get_database_url()
    max_overflow = max(0, config.database_max_open_conns - config.database_max_idle_conns)
    await init_database(
        database_url,
        pool_size=config.database_max_idle_conns,
        max_overflow=max_overflow,
        pool_recycle=config.database_max_life_time,
        pool_pre_ping=True,
        ssl_mode=config.database_ssl_mode,
    )
    logger.info("Database initialized")
    
    # Start API key refresher task
    refresher_task = asyncio.create_task(api_key_refresher())
    logger.info("API key refresher task started")
    
    # TronGrid API Key (shared across networks) — set in environment for the underlying library
    trongrid_api_key = await config.get_trongrid_api_key()
    if trongrid_api_key:
        os.environ["TRON_GRID_API_KEY"] = trongrid_api_key
        logger.info("TronGrid API Key retrieved and injected into environment")
    else:
        logger.warning("TronGrid API Key not configured. Using default rate limits for blockchain requests.")

    # Initialize facilitator per network (each has its own fee_to_address, base_fee, private_key)
    for network in config.networks:
        if network not in to_internal_network:
            logger.warning(f"Unknown network mapping: {network}, skipping")
            continue
        internal_network = to_internal_network[network]
        private_key = await config.get_private_key(network)
        fee_to = config.get_fee_to_address(network)
        base_fee = config.get_base_fee(network)
        if is_tron_network(network):
            facilitator_signer = TronFacilitatorSigner.from_private_key(private_key=private_key)
            facilitator_mechanism = ExactPermitTronFacilitatorMechanism(
                facilitator_signer,
                fee_to=fee_to,
                base_fee=base_fee,
            )
            x402_facilitator.register([internal_network], facilitator_mechanism)
            facilitator_mechanism = ExactTronFacilitatorMechanism(
                facilitator_signer,
            )
            x402_facilitator.register([internal_network], facilitator_mechanism)
            # GasFree mechanism
            try:
                gasfree_client = GasFreeAPIClient(
                    NetworkConfig.get_gasfree_api_base_url(network)
                )
                gasfree_mechanism = ExactGasFreeFacilitatorMechanism(
                    facilitator_signer,
                    clients={network: gasfree_client},
                    base_fee=base_fee,
                )
                x402_facilitator.register([internal_network], gasfree_mechanism)
                logger.info(f"GasFree mechanism registered for {network}")
            except Exception as e:
                logger.warning(f"GasFree mechanism not available for {network}: {e}")
            logger.info(f"Facilitator registered for {network}")
        elif is_bsc_network(network) or is_eth_network(network):
            facilitator_signer = EvmFacilitatorSigner.from_private_key(private_key=private_key)
            facilitator_mechanism = ExactPermitEvmFacilitatorMechanism(
                facilitator_signer,
                fee_to=fee_to,
                base_fee=base_fee,
            )
            x402_facilitator.register([internal_network], facilitator_mechanism)

            facilitator_mechanism = ExactEvmFacilitatorMechanism(
                facilitator_signer,
            )
            x402_facilitator.register([internal_network], facilitator_mechanism)

            logger.info(f"Facilitator registered for {network}")
        else:
            logger.warning(f"Unsupported network: {network}")
            continue
    
    yield
    
    # Shutdown
    refresher_task.cancel()
    try:
        await refresher_task
    except asyncio.CancelledError:
        pass
    await dispose_engine()
    logger.info("Shutting down...")

# Init app
app = FastAPI(
    title="X402 Facilitator",
    description="Facilitator service for X402 payment protocol",
    version="1.0.0",
    lifespan=lifespan,
)

# Setup sub-systems
instrumentator = attach_prometheus_middleware(app)
setup_auth(app)

# Add CORS middleware (allow_credentials=False when using "*" per CORS spec)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    """Health check for K8s / load balancer liveness probe. No rate limit."""
    return {"status": "ok"}


@app.get("/supported")
async def supported(request: Request):
    """Get supported capabilities"""
    return x402_facilitator.supported(pricing="flat")

@app.post("/fee/quote")
async def fee_quote(request: Request, request_data: FeeQuoteRequest):
    """Get fee quote for payment requirements"""
    return await x402_facilitator.fee_quote(
        request_data.accepts,
        request_data.paymentPermitContext
    )

@app.post("/verify", response_model=VerifyResponse)
async def verify(request: Request, verify_request: VerifyRequest):
    """Verify payment payload"""
    try:
        return await x402_facilitator.verify(verify_request.paymentPayload, verify_request.paymentRequirements)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Verify failed")
        raise HTTPException(status_code=500, detail="Internal server error")

def _get_payment_id_from_request(request_data: SettleRequest) -> str | None:
    """Safely extract payment_id from request; returns None if structure is invalid."""
    try:
        return request_data.paymentPayload.payload.payment_permit.meta.payment_id
    except AttributeError:
        return None

def _get_network_from_request(request_data: SettleRequest) -> str | None:
    """Safely extract network from request; returns None if structure is invalid."""
    try:
        return request_data.paymentRequirements.network
    except AttributeError:
        return None

async def _get_seller_id_from_api_key(api_key: str | None) -> str | None:
    """Get seller id from api key.
    if api_key is None, return None.
    if api_key is not None, get the seller id from the database.
    if the seller id is not found, return None.
    return the seller id.
    """

    if api_key is None:
        return None

    api_key_record = await get_api_key_by_key(api_key)
    if api_key_record is None:
        return None
    return api_key_record.seller_id

@app.post("/settle", response_model=SettleResponse)
@limiter.limit(get_dynamic_rate_limit, key_func=get_dynamic_key_func)
async def settle(request: Request, request_data: SettleRequest):
    """Settle payment on-chain. Calls settle first; if payment_id present, writes one record after. Save failure does not affect response."""
    payment_id = _get_payment_id_from_request(request_data)

    try:
        result = await x402_facilitator.settle(
            request_data.paymentPayload, request_data.paymentRequirements
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception:
        logger.exception("Settle failed")
        raise HTTPException(status_code=500, detail="Internal server error")

    tx_hash = result.transaction or ""
    status = "success" if result.success else "failed"
    try:
        network = _get_network_from_request(request_data)
        seller_id = await _get_seller_id_from_api_key(getattr(request.state, "api_key", None))
        await save_payment_record(payment_id, seller_id, network, tx_hash, status)
        logger.info(f"Payment record saved: {seller_id} {network} {payment_id} -> {tx_hash}")
    except Exception:
        logger.exception("Failed to save payment record (settle result still returned): payment_id=%s", payment_id)

    return result

@app.get("/payments/{payment_id}", response_model=list[PaymentRecordResponse])
async def get_payment(request: Request, payment_id: str):
    """Get payment record by payment_id."""
    seller_id = await _get_seller_id_from_api_key(getattr(request.state, "api_key", None))
    records = await get_payment_by_id(payment_id, seller_id)
    if not records:
        raise HTTPException(status_code=404, detail="Payment not found")
    return [_payment_record_to_response(record) for record in records]


@app.get("/payments/tx/{tx_hash}", response_model=list[PaymentRecordResponse])
async def get_payment_by_tx(request: Request, tx_hash: str):
    """Get payment record by transaction hash. Returns latest if multiple."""
    seller_id = await _get_seller_id_from_api_key(getattr(request.state, "api_key", None))
    records = await get_payment_by_tx_hash(tx_hash, seller_id)
    if not records:
        raise HTTPException(status_code=404, detail="Payment not found")
    return [_payment_record_to_response(record) for record in records]


def _payment_record_to_response(record):
    """Build PaymentRecordResponse from PaymentRecord."""
    return PaymentRecordResponse(
        paymentId=record.payment_id,
        txHash=record.tx_hash,
        status=record.status,
        createdAt=record.created_at,
    )

def main():
    """Start the facilitator server"""
    print("Starting X402 Facilitator Server")
    config.load_from_yaml()
    uvicorn.run(
        "main:app",
        host=config.server_host,
        port=config.server_port,
        log_level="info",
        workers=config.server_workers,
    )

if __name__ == "__main__":
    main()
