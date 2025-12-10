/**
 * Utility functions for formatting errors into detailed text reports
 */

export function formatErrorDetails(error: any, context?: string): string {
  const timestamp = new Date().toISOString();
  let errorReport = "ERROR DETAILS REPORT\n";
  errorReport += "=".repeat(50) + "\n\n";

  errorReport += `Timestamp: ${timestamp}\n`;

  if (context) {
    errorReport += `Context: ${context}\n`;
  }

  errorReport += "\n";

  // Basic error info
  if (error instanceof Error) {
    errorReport += `Error Type: ${error.constructor.name}\n`;
    errorReport += `Message: ${error.message}\n\n`;

    // Stack trace
    if (error.stack) {
      errorReport += "Stack Trace:\n";
      errorReport += "-".repeat(30) + "\n";
      errorReport += error.stack + "\n\n";
    }
  } else if (typeof error === "object" && error !== null) {
    errorReport += "Error Object:\n";
    errorReport += "-".repeat(30) + "\n";
    errorReport += JSON.stringify(error, null, 2) + "\n\n";
  } else {
    errorReport += `Error: ${String(error)}\n\n`;
  }

  // Add additional properties for API errors
  if (error && typeof error === "object") {
    const additionalProps = ["status", "statusText", "headers", "request_id", "requestID", "type"];
    const foundProps: Record<string, any> = {};

    for (const prop of additionalProps) {
      if (error[prop] !== undefined) {
        foundProps[prop] = error[prop];
      }
    }

    if (Object.keys(foundProps).length > 0) {
      errorReport += "Additional Properties:\n";
      errorReport += "-".repeat(30) + "\n";

      for (const [key, value] of Object.entries(foundProps)) {
        if (key === "headers" && typeof value === "object") {
          // Special handling for headers
          errorReport += `${key}:\n`;
          if (value && typeof value.entries === "function") {
            // Headers object with entries method
            for (const [hKey, hValue] of value.entries()) {
              errorReport += `  ${hKey}: ${hValue}\n`;
            }
          } else if (value && typeof value === "object") {
            // Plain object headers
            for (const [hKey, hValue] of Object.entries(value)) {
              errorReport += `  ${hKey}: ${hValue}\n`;
            }
          }
        } else {
          errorReport += `${key}: ${JSON.stringify(value, null, 2)}\n`;
        }
      }
      errorReport += "\n";
    }
  }

  // Add nested error information if present
  if (error?.error) {
    errorReport += "Nested Error Information:\n";
    errorReport += "-".repeat(30) + "\n";
    errorReport += JSON.stringify(error.error, null, 2) + "\n\n";
  }

  return errorReport;
}

export function createErrorAttachment(
  error: any,
  context?: string,
): {
  name: string;
  content: string;
  mimeType: string;
} {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const errorDetails = formatErrorDetails(error, context);

  return {
    name: `error_${timestamp}.txt`,
    content: errorDetails,
    mimeType: "text/plain",
  };
}
