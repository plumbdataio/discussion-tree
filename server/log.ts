// Logger pinned to stderr — stdout is reserved for the MCP protocol stream
// and any byte we emit there will be parsed as a (broken) JSON-RPC message
// by Claude Code. console.log() must NEVER appear in this codebase.

export function log(msg: string) {
  console.error(`[parallel-discussion] ${msg}`);
}
