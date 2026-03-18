"""
Logging setup - daily log files with date+time in filename (new file each start).
"""

import logging
import os
import sys
from datetime import datetime
from logging.handlers import TimedRotatingFileHandler


class DailyRotatingFileHandler(TimedRotatingFileHandler):
    """
    Log file with date+time in filename. Each start creates a new file.
    Produces: x402-facilitator.2026-02-09_14-30-25.log
    """

    def __init__(self, log_dir: str, base_name: str, encoding: str = "utf-8"):
        self._log_dir = log_dir
        self._base_name = base_name.rstrip(".log") if base_name.endswith(".log") else base_name
        log_path = self._get_current_path()
        super().__init__(
            filename=log_path,
            when="midnight",
            interval=1,
            backupCount=0,
            encoding=encoding,
        )

    def _get_current_path(self) -> str:
        """Log file path with date and time (new file each start)."""
        now = datetime.now()
        return os.path.join(self._log_dir, f"{self._base_name}.{now:%Y-%m-%d_%H-%M-%S}.log")

def setup_logging(logging_config=None):
    """
    Setup logging configuration.
    File logging: daily filename with date+time, new file each start.
    """
    root_logger = logging.getLogger()

    level_str = logging_config.get("level", "INFO").upper() if logging_config else "INFO"
    level = getattr(logging, level_str, logging.INFO)
    root_logger.setLevel(level)

    for handler in root_logger.handlers[:]:
        root_logger.removeHandler(handler)

    formatter = logging.Formatter(
        "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
    )

    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(formatter)
    root_logger.addHandler(console_handler)

    if logging_config and logging_config.get("dir") and logging_config.get("filename"):
        log_dir = logging_config.get("dir", "logs")
        filename = logging_config.get("filename", "app.log")
        base_name = filename.replace(".log", "") if filename.endswith(".log") else filename
        os.makedirs(log_dir, exist_ok=True)

        try:
            file_handler = DailyRotatingFileHandler(
                log_dir=log_dir,
                base_name=base_name,
                encoding="utf-8",
            )
            file_handler.setFormatter(formatter)
            root_logger.addHandler(file_handler)
            logging.info(f"File logging enabled: {file_handler.baseFilename} (Level: {level_str})")
        except Exception as e:
            logging.error(f"Failed to setup file logging: {e}")
