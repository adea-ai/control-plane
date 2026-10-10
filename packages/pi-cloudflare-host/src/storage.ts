import { openDurableObjectSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/cloudflare'
import type { Storage } from '@earendil-works/pi-durable'
import type { DurableObjectSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/cloudflare'

/** Open the real Pi1.1 storage facade; do not import Node SQLite/leases in a Worker. */
export const openCloudflarePiStorage = (storage: DurableObjectSqliteStorage): Promise<Storage> =>
  openDurableObjectSqliteStorage(storage)
