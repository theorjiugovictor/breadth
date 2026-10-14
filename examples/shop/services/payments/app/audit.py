import json
import logging

log = logging.getLogger("audit")


def record(event: dict) -> None:
    """Write an audit event (resolved dynamically by the charge handler)."""
    log.info(json.dumps(event))
