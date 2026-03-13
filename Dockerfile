# x402-tron-facilitator Docker image
# Python 3.12 slim for smaller image
FROM python:3.12-slim

# Prevent Python from writing pyc files and buffering stdout/stderr
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

WORKDIR /app

# Build deps: gcc for wheels, git for pip install from git URLs
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency file first for better layer caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY src/ ./src/

# Create non-root user for running the application
RUN useradd -r -s /bin/false appuser

# Create logs directory (config may write here)
RUN mkdir -p logs && chown appuser:appuser logs

EXPOSE 8001 9001

USER appuser

# Default: run facilitator. Override CMD for custom entry.
CMD ["python", "src/main.py"]
