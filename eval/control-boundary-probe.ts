import fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const outputPath = process.env.PI_SCRUTINY_BOUNDARY_PROBE_OUT;

export default function (pi: ExtensionAPI) {
	pi.registerCommand("scrutiny-boundary-probe", {
		description: "Inspect extension registration for boundary eval",
		handler: async () => {
			if (!outputPath) return;
			fs.writeFileSync(outputPath, JSON.stringify({ tools: pi.getAllTools(), commands: pi.getCommands() }, null, 2));
		},
	});
}
