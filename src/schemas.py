from datetime import datetime
from pydantic import BaseModel, Field
from bankofai.x402.schemas import (
    PaymentPayload,
    PaymentRequirements,
)

class VerifyRequest(BaseModel):
    """Verify request model"""
    paymentPayload: PaymentPayload
    paymentRequirements: PaymentRequirements


class SettleRequest(BaseModel):
    """Settle request model"""
    paymentPayload: PaymentPayload
    paymentRequirements: PaymentRequirements


class FeeQuoteRequest(BaseModel):
    """Fee quote request model"""
    accepts: list[PaymentRequirements]
    paymentPermitContext: dict | None = None


class PaymentRecordResponse(BaseModel):
    """Payment record response model"""
    payment_id: str = Field(alias="paymentId")
    tx_hash: str = Field(alias="txHash")
    status: str
    created_at: datetime = Field(alias="createdAt")
    
    class Config:
        populate_by_name = True
