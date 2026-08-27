export const AGENT_RUN_REQUEST_SEMANTICS = ["STRICT_CURRENT", "LEGACY_BOUND"] as const;
export type AgentRunRequestSemantics = (typeof AGENT_RUN_REQUEST_SEMANTICS)[number];

export const CURRENT_AGENT_RUN_REQUEST_SEMANTICS: AgentRunRequestSemantics = "STRICT_CURRENT";
export const LEGACY_BOUND_AGENT_RUN_REQUEST_SEMANTICS: AgentRunRequestSemantics = "LEGACY_BOUND";
