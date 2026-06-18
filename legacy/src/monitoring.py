import logging
from fastapi import FastAPI
from prometheus_fastapi_instrumentator import Instrumentator

logger = logging.getLogger(__name__)

def attach_prometheus_middleware(main_app: FastAPI) -> Instrumentator:
    """
    Attach Prometheus instrumentation middleware to the main app.
    Must be called before app startup.
    """
    return Instrumentator().instrument(main_app)

def start_monitoring_server(instrumentator: Instrumentator, main_app: FastAPI, config):
    """
    Configure metrics exposure.
    If ports match, expose on main app.
    If ports differ, start a separate uvicorn server in a thread.
    Should be called after config is loaded (e.g. in lifespan).
    """
    try:
        # If same port, expose on main app
        if config.monitoring_port == config.server_port:
            instrumentator.expose(main_app, endpoint=config.monitoring_endpoint)
            logger.info(f"Prometheus monitoring enabled on main port at {config.monitoring_endpoint}")
        else:
            # Different port, create separate app and run in thread
            metrics_app = FastAPI(title="X402 Metrics")
            instrumentator.expose(metrics_app, endpoint=config.monitoring_endpoint)
            
            import threading
            import uvicorn
            import inspect
            
            def run_metrics():
                try:
                    logger.info(f"Starting uvicorn for metrics on {config.server_host}:{config.monitoring_port}...")
                    
                    kwargs = {
                        "host": config.server_host,
                        "port": config.monitoring_port,
                        "log_level": "error",
                    }
                    
                    # Some versions of uvicorn (0.11.0 to < 0.29.0) require install_signal_handlers=False
                    # to run in a thread. Newer versions (0.29.0+) removed this parameter from Config.
                    sig = inspect.signature(uvicorn.Config.__init__)
                    if "install_signal_handlers" in sig.parameters:
                        kwargs["install_signal_handlers"] = False
                    
                    metrics_config = uvicorn.Config(metrics_app, **kwargs)
                    server = uvicorn.Server(metrics_config)
                    server.run()
                except Exception as e:
                    logger.error(f"Metrics server thread crashed: {e}", exc_info=True)

            t = threading.Thread(target=run_metrics, daemon=True)
            t.start()
            logger.info(f"Prometheus monitoring server started on separate port {config.monitoring_port} at {config.monitoring_endpoint}")
            
    except Exception as e:
        logger.error(f"Failed to initialize monitoring server: {e}")
