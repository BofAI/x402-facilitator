from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field
from bankofai.x402.types import (
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
    model_config = ConfigDict(populate_by_name=True)

    payment_id: str | None = Field(alias="paymentId")
    tx_hash: str = Field(alias="txHash")
    status: str
    created_at: datetime = Field(alias="createdAt")
