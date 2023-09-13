import { Store, Options, ClientRateLimitInfo } from 'express-rate-limit'

import Pool from 'pg-pool'
import { Session } from '../../models/session'
import { getSession, isSessionValid } from '../../util/session_handler'
import { applyMigrations } from '../../util/migration_handler'

/**
 * A `Store` for the `express-rate-limit` package that stores hit counts in
 * PostgreSQL.
 *
 * @public
 */
class PostgresStoreAggregatedIP implements Store {
	/**
	 * The database configuration as specified in https://node-postgres.com/apis/client.
	 */
	config: any

	/**
	 * The name of the session
	 */
	name: string

	/**
	 * The type of session (as an enum)
	 */
	SESSION_TYPE: string = 'aggregated'

	/**
	 * The database connection pool.
	 */
	pool: any

	/**
	 * The session instance persisted on the client side.
	 */
	session: Session = {
		id: 'init',
		name: 'init',
		type: this.SESSION_TYPE,
		expires_at: undefined,
	}

	/**
	 * The duration of time before which all hit counts are reset (in milliseconds).
	 */
	windowMs!: number

	/**
	 * The time at which all hit counts will be reset.
	 */
	resetTime!: Date

	/**
	 * @constructor for `PostgresStoreAggregatedIP`.
	 *
	 * @param config {JSON} - The database configuration as specified in https://node-postgres.com/apis/client.
	 * @param name {string} - The unique name of the session. This is useful when applying multiple rate limiters with multiple stores.
	 */
	constructor(config: any, name: string) {
		this.config = config
		this.name = name
		applyMigrations(config)
	}

	/**
	 * Method that actually initializes the store. Must be synchronous.
	 *
	 * This method is optional, it will be called only if it exists.
	 *
	 * @param options {Options} - The options used to setup express-rate-limit.
	 *
	 * @public
	 */
	init(options: Options): void {
		this.windowMs = options.windowMs
		this.pool = new Pool(this.config)
	}

	/**
	 * Method to increment a client's hit counter.
	 *
	 * @param key {string} - The identifier for a client.
	 *
	 * @returns {ClientRateLimitInfo} - The number of hits and reset time for that client.
	 *
	 * @public
	 */
	async increment(key: string): Promise<ClientRateLimitInfo> {
		let recordInsertGetRecordsQuery = `
            INSERT INTO rate_limit.records_aggregated(key, session_id) VALUES ($1, $2)
            ON CONFLICT ON CONSTRAINT unique_session_key DO UPDATE
            SET count = records_aggregated.count + 1
            RETURNING count
            `
		if (!isSessionValid(this.session)) {
			this.session = await getSession(
				this.name,
				this.SESSION_TYPE,
				this.windowMs,
				this.pool,
			)
		}

		try {
			let result = await this.pool.query(recordInsertGetRecordsQuery, [
				key,
				this.session.id,
			])
			let totalHits: number = 0
			if (result.rows.length > 0) totalHits = parseInt(result.rows[0].count)
			let resetTime: Date | undefined = this.session.expires_at
			return {
				totalHits,
				resetTime,
			}
		} catch (err) {
			console.error(err)
			throw err
		}
	}

	/**
	 * Method to decrement a client's hit counter.
	 *
	 * @param key {string} - The identifier for a client.
	 *
	 * @public
	 */
	async decrement(key: string): Promise<void> {
		let decrementQuery = `
            UPDATE rate_limit.records_aggregated
            SET count = greatest(0, count-1)
            WHERE key = $1 and session_id = $2          
        `

		try {
			await this.pool.query(decrementQuery, [key, this.session.id])
		} catch (err) {
			console.error(err)
			throw err
		}
	}

	/**
	 * Method to reset a client's hit counter.
	 *
	 * @param key {string} - The identifier for a client.
	 *
	 * @public
	 */
	async resetKey(key: string): Promise<void> {
		let resetQuery = `
            DELETE FROM rate_limit.records_aggregated
            WHERE key = $1 and session_id = $2
            `

		try {
			await this.pool.query(resetQuery, [key, this.session.id])
		} catch (err) {
			console.error(err)
			throw err
		}
	}

	/**
	 * Method to reset everyone's hit counter.
	 *
	 * This method is optional, it is never called by express-rate-limit.
	 *
	 * @public
	 */
	async resetAll(): Promise<void> {
		let resetAllQuery = `
            DELETE FROM rate_limit.records_aggregated WHERE session_id = $1
            `

		try {
			await this.pool.query(resetAllQuery, [this.session.id])
		} catch (err) {
			console.error(err)
			throw err
		}
	}
}

export default PostgresStoreAggregatedIP