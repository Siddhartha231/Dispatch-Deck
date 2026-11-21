import type { CollectionSchema } from 'deepspace/schema'
import { usersSchema } from './schemas/users-schema'
import { runs, notes, memberships } from './schemas/dispatch'

/** Collections registered with the app's RecordRoom. */
export const schemas: CollectionSchema[] = [usersSchema, runs, notes, memberships]
