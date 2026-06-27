// Registers an in-process resolve hook that remaps relative ".js" specifiers
// to ".ts" when the .ts file exists, so extension modules (which keep .js
// imports for pi/bun) can be imported by node --experimental-strip-types unit
// tests. No new deps; no worker thread.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

function candidateTsUrl(specifier: string, parentURL: string | undefined): string | undefined {
	if (!specifier.endsWith(".js")) return undefined;
	let candidate: string;
	if (specifier.startsWith("file:")) {
		try {
			candidate = fileURLToPath(new URL(specifier.slice(0, -".js".length) + ".ts"));
		} catch {
			return undefined;
		}
	} else if (specifier.startsWith("./") || specifier.startsWith("../")) {
		if (!parentURL) return undefined;
		const parentDir = path.dirname(fileURLToPath(parentURL));
		candidate = path.resolve(parentDir, specifier.slice(0, -".js".length) + ".ts");
	} else {
		return undefined;
	}
	return fs.existsSync(candidate) ? pathToFileURL(candidate).href : undefined;
}

registerHooks({
	resolve: (specifier, context, nextResolve) => {
		const tsUrl = candidateTsUrl(specifier, context.parentURL);
		if (tsUrl) return { url: tsUrl, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
