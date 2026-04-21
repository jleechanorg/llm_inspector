/**
 * TypeScript interfaces for captured LLM API requests and analysis results.
 */

/** A single message in an LLM conversation. */
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentBlock[];
  name?: string;
  tool_call_id?: string;
}

/** Content block within a message (Anthropic format). */
export interface ContentBlock {
  type: "text" | "image" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: string | ContentBlock[];
}

/** Tool definition as sent in API requests. */
export interface ToolDefinition {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  /** OpenAI format */
  function?: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** The request body sent to an LLM API. */
export interface RequestBody {
  model?: string;
  messages?: Message[];
  system?: string | ContentBlock[];
  tools?: ToolDefinition[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  [key: string]: unknown;
}

/** A captured API request payload. */
export interface CapturedRequest {
  /** ISO timestamp of capture */
  timestamp: string;
  /** HTTP method */
  method: string;
  /** Request path */
  path: string;
  /** Target API URL */
  url: string;
  /** Request headers (sensitive values redacted in storage) */
  headers: Record<string, string>;
  /** Full request body */
  body: RequestBody;
  /** Total body size in bytes */
  bodySize: number;
  /** Response data (if captured) */
  response?: {
    status: number;
    body?: unknown;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  /** Raw HTTP request (HTTP/1.1 format: headers + body) */
  request_raw?: string;
  /** Raw HTTP response (HTTP/1.1 format: status line + headers + body) */
  response_raw?: string;
  /** Capture file path (runtime only, not persisted) */
  filePath?: string;
}

/** Detail row for a sub-component (e.g., individual tool or MCP server). */
export interface ComponentDetail {
  name: string;
  bytes: number;
  tokens: number;
}

/** Token breakdown for a single component of the request. */
export interface ComponentBreakdown {
  component: string;
  bytes: number;
  tokens: number;
  percentage: number;
  details?: ComponentDetail[];
}

/** Full analysis result for a captured request. */
export interface AnalysisResult {
  totalBytes: number;
  estimatedTokens: number;
  breakdown: ComponentBreakdown[];
  model?: string;
  userMessageBytes: number;
}

/** Proxy server configuration. */
export interface ProxyConfig {
  /** Port to listen on */
  port: number;
  /** Override upstream URL (auto-detected if not set) */
  upstream?: string;
  /** Whether to log requests to console */
  verbose: boolean;
}
