// `wrangler types` can't see the Sandbox class because Flue generates the
// Worker entry, so narrow the generated binding here for getSandbox().
declare namespace Cloudflare {
	interface Env {
		Sandbox: DurableObjectNamespace<import('@cloudflare/sandbox').Sandbox>;
	}
}
