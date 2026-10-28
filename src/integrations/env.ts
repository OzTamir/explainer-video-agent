/**
 * Environment access for the Worker. With `nodejs_compat`, Cloudflare populates
 * `process.env` from Worker vars and secrets, and `vite dev` loads `.dev.vars`,
 * so one accessor serves both.
 */

export function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing required environment variable ${name}`);
	return value;
}

export function optionalEnv(name: string): string | undefined {
	const value = process.env[name];
	return value ? value : undefined;
}
