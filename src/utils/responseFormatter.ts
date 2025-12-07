import { MAX_CODE_OUTPUT_LENGTH } from "../constants";
import { GeneratedFile, ClaudeCodeExecutionResult } from "../types";

/**
 * Format code execution results for Discord display
 */
export function formatCodeExecutionResult(
  codeResult: ClaudeCodeExecutionResult,
  codeExecutionMap: Map<string, any>,
): { text: string; files: GeneratedFile[] } {
  let resultText = "";
  const generatedFiles: GeneratedFile[] = [];

  // Try to find the corresponding tool use to get the code/command
  const toolUse = codeResult.tool_use_id ? codeExecutionMap.get(codeResult.tool_use_id) : null;

  if (!toolUse && codeResult.tool_use_id) {
    console.log(`  ⚠️ Could not find tool use for ID: ${codeResult.tool_use_id}`);
    console.log(`    Available IDs in map: ${Array.from(codeExecutionMap.keys()).join(", ")}`);
  }

  // Check for output in either 'output' or 'content' field (Anthropic uses 'content')
  const output = codeResult.output || (codeResult as any).content;

  if (codeResult.type === "text_editor_code_execution_tool_result") {
    // Handle text editor results (file creation or code execution)
    if (output && output.type === "text_editor_code_execution_create_result") {
      // File creation result - show what was written to the file
      resultText = "\n\n📝 **File Created:**\n";
      if (toolUse && toolUse.input) {
        // The input might have 'path' and 'text' or 'code' fields
        const filePath = toolUse.input.path || toolUse.input.file_path || "/tmp/untitled.py";
        const fileContent = toolUse.input.text || toolUse.input.code || toolUse.input.content || "";

        resultText += `Path: \`${filePath}\`\n`;
        if (fileContent) {
          resultText += "```python\n" + fileContent + "\n```\n";
        } else if (toolUse.input) {
          // If we can't find the content in expected fields, show the whole input for debugging
          resultText += `Debug - Tool input: \`\`\`json\n${JSON.stringify(toolUse.input, null, 2)}\n\`\`\`\n`;
        }
      }
      resultText += output.is_file_update ? "(File updated)" : "(New file created)";
      return { text: resultText, files: generatedFiles };
    } else {
      // Direct code execution
      resultText = "\n\n📝 **Python Code Execution:**\n";
      if (toolUse && toolUse.input && toolUse.input.code) {
        resultText += "```python\n" + toolUse.input.code + "\n```\n";
      }
      resultText += "**Output:**\n```\n";
    }
  } else {
    resultText = "\n\n🖥️ **Bash Command Execution:**\n";
    if (toolUse && toolUse.input && toolUse.input.command) {
      resultText += "```bash\n" + toolUse.input.command + "\n```\n";
    }
    resultText += "**Output:**\n```\n";
  }

  if (output) {
    let outputStr = "";

    // Handle different output formats
    if (typeof output === "string") {
      outputStr = output;
    } else if (output.stdout !== undefined || output.stderr !== undefined) {
      // Handle structured output with stdout/stderr
      if (output.stdout) {
        outputStr = output.stdout;
      }
      if (output.stderr) {
        outputStr += (outputStr ? "\n" : "") + `[stderr] ${output.stderr}`;
      }
      if (!outputStr && output.return_code !== undefined && output.return_code !== 0) {
        outputStr = `Process exited with code ${output.return_code}`;
      }
    } else if (output.type === "text_editor_code_execution_result" && output.output) {
      // Direct execution result from text editor
      outputStr = output.output;
    } else if (output.type !== "text_editor_code_execution_create_result") {
      // Don't show JSON for file creation results (already handled above)
      outputStr = JSON.stringify(output);
    }

    // Limit output to prevent overly long messages
    const maxOutputLength = MAX_CODE_OUTPUT_LENGTH || 1500;
    if (outputStr) {
      if (outputStr.length > maxOutputLength) {
        resultText += outputStr.substring(0, maxOutputLength) + "\n... (output truncated)\n";
      } else {
        resultText += outputStr + "\n";
      }
    } else {
      resultText += "(No output)\n";
    }
  } else if (codeResult.error) {
    resultText += `Error: ${codeResult.error}\n`;
  } else {
    resultText += "(No output)\n";
  }

  // Check for generated files in the code execution result
  if (codeResult.files && Array.isArray(codeResult.files)) {
    for (const file of codeResult.files) {
      if (file.name && file.content) {
        // Decode base64 content if present
        let fileContent = file.content;
        if ((file as any).encoding === "base64") {
          fileContent = Buffer.from(file.content, "base64").toString();
        }

        generatedFiles.push({
          name: file.name,
          content: fileContent,
          mimeType: file.mimeType || getMimeType(file.name),
        });

        resultText += `\n📎 Generated file: ${file.name}`;
      }
    }
  }

  resultText += "```";

  return { text: resultText, files: generatedFiles };
}

/**
 * Format web search results for logging
 */
export function formatWebSearchResults(webSearchResults: any[]): void {
  if (webSearchResults.length === 0) return;

  let searchQuery = "";
  let resultCount = 0;
  const urls: string[] = [];

  // Count results and collect URLs
  for (const resultBlock of webSearchResults) {
    const results = (resultBlock as any).content || [];
    for (const result of results) {
      if (result.type === "web_search_result") {
        resultCount++;
        if (result.url) {
          urls.push(result.url);
        }
      }
    }
  }

  console.log(`🔍 Web search occurred: "${searchQuery}" - found ${resultCount} results`);
  console.log(`   URLs found: ${urls.slice(0, 3).join(", ")}${urls.length > 3 ? "..." : ""}`);

  // Log first result structure for debugging
  const firstResult = ((webSearchResults[0] as any).content || [])[0];
  if (firstResult) {
    console.log("\n   First result structure:");
    console.log(`     Title: ${firstResult.title || "No title"}`);
    console.log(`     URL: ${firstResult.url || "No URL"}`);
    if (firstResult.snippet) {
      console.log(
        `     Snippet: ${firstResult.snippet.substring(0, 100)}${
          firstResult.snippet.length > 100 ? "..." : ""
        }`,
      );
    }
  }
}

/**
 * Format citations for a text block
 */
export function formatCitations(
  citations: any[],
  urlToCitationNum: Map<string, number>,
  citationCounter: { value: number },
): string {
  if (!citations || !Array.isArray(citations)) return "";

  // First, deduplicate citations by URL within this block
  const uniqueCitations = new Map<string, any>();
  for (const citation of citations) {
    if (citation.url && !uniqueCitations.has(citation.url)) {
      uniqueCitations.set(citation.url, citation);
    }
  }

  // Build citation links
  const citationLinks: string[] = [];
  for (const citation of uniqueCitations.values()) {
    let citationNum: number;

    // Check if we've already seen this URL
    if (urlToCitationNum.has(citation.url)) {
      citationNum = urlToCitationNum.get(citation.url)!;
    } else {
      citationNum = citationCounter.value++;
      urlToCitationNum.set(citation.url, citationNum);
    }

    // Add citation link with <> to prevent embeds
    citationLinks.push(`[${citationNum}](<${citation.url}>)`);
  }

  // Return formatted citations
  return citationLinks.length > 0 ? ` (${citationLinks.join(", ")})` : "";
}

/**
 * Get MIME type from file extension
 */
function getMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "json":
      return "application/json";
    case "txt":
      return "text/plain";
    case "py":
      return "text/x-python";
    case "js":
      return "application/javascript";
    case "html":
      return "text/html";
    case "css":
      return "text/css";
    case "md":
      return "text/markdown";
    default:
      return "text/plain";
  }
}
