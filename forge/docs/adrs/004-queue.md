# ADR-004: Queue (BullMQ behind port)

- **Status:** Accepted  
- **Date:** 2026-08-02  
- **Evidence:** `PACKAGE-EVIDENCE.md`, architecture research

## Decision

- Use **BullMQ `^6`** + Redis behind `QueuePort`.  
- Job payloads are Zod-validated `ForgeJob` DTOs.  
- Workers must **not** hold BullMQ locks across human approval waits — checkpoint, ack, resume via new job.  
- `InMemoryQueuePort` for tests.

## Alternatives

Temporal (overlap with engine), raw Redis lists (reinvent retries).
