/**
 * Structured logging utilities.
 */

/**
 * Log levels.
 */
export enum LogLevel {
  Debug = "debug",
  Info = "info",
  Warn = "warn",
  Error = "error",
}

/**
 * Log entry structure.
 */
export interface LogEntry {
  readonly level: LogLevel;
  readonly timestamp: string;
  readonly message: string;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly error?: {
    readonly message: string;
    readonly stack?: string;
    readonly code?: string;
  };
}

/**
 * Logger configuration.
 */
export interface LoggerConfig {
  readonly level: LogLevel;
  readonly output: "stdout" | "stderr" | "none";
  readonly includeTimestamp: boolean;
  readonly includeLevel: boolean;
  readonly jsonOutput: boolean;
}

/**
 * Default logger configuration.
 */
export const DEFAULT_LOGGER_CONFIG: LoggerConfig = {
  level: LogLevel.Info,
  output: "stderr",
  includeTimestamp: true,
  includeLevel: true,
  jsonOutput: false,
} as const;

/**
 * Check if a level should be logged based on configured level.
 */
function shouldLog(level: LogLevel, configuredLevel: LogLevel): boolean {
  const levels = [LogLevel.Debug, LogLevel.Info, LogLevel.Warn, LogLevel.Error];
  return levels.indexOf(level) >= levels.indexOf(configuredLevel);
}

/**
 * Format a log entry as text.
 */
function formatLogEntry(entry: LogEntry, config: LoggerConfig): string {
  const parts: string[] = [];

  if (config.includeTimestamp) {
    parts.push(entry.timestamp);
  }

  if (config.includeLevel) {
    parts.push(`[${entry.level.toUpperCase()}]`);
  }

  parts.push(entry.message);

  if (entry.context) {
    const contextStr = Object.entries(entry.context)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");
    parts.push(`(${contextStr})`);
  }

  let output = parts.join(" ");

  if (entry.error) {
    output += `\n  Error: ${entry.error.message}`;
    if (entry.error.stack) {
      output += `\n  Stack: ${entry.error.stack}`;
    }
    if (entry.error.code) {
      output += `\n  Code: ${entry.error.code}`;
    }
  }

  return output;
}

/**
 * Logger class.
 */
export class Logger {
  readonly config: LoggerConfig;

  constructor(config: Partial<LoggerConfig> = {}) {
    this.config = { ...DEFAULT_LOGGER_CONFIG, ...config };
  }

  /**
   * Create a log entry.
   */
  private createEntry(
    level: LogLevel,
    message: string,
    context?: Readonly<Record<string, unknown>>,
    error?: Error
  ): LogEntry {
    const partial: {
      level: LogLevel;
      timestamp: string;
      message: string;
      context?: Readonly<Record<string, unknown>>;
      error?: {
        message: string;
        stack?: string;
        code?: string;
      };
    } = {
      level,
      timestamp: new Date().toISOString(),
      message,
    };

    if (context && Object.keys(context).length > 0) {
      partial.context = context;
    }

    if (error) {
      const errorInfo: {
        message: string;
        stack?: string;
        code?: string;
      } = {
        message: error.message,
      };
      if (error.stack !== undefined) {
        errorInfo.stack = error.stack;
      }
      const errorCode = (error as { code?: string }).code;
      if (errorCode !== undefined) {
        errorInfo.code = errorCode;
      }
      partial.error = errorInfo;
    }

    return partial as LogEntry;
  }

  /**
   * Write a log entry.
   */
  private write(entry: LogEntry): void {
    if (!shouldLog(entry.level, this.config.level)) {
      return;
    }

    if (this.config.output === "none") {
      return;
    }

    const output = this.config.output === "stderr" ? console.error : console.log;

    if (this.config.jsonOutput) {
      output(JSON.stringify(entry));
    } else {
      output(formatLogEntry(entry, this.config));
    }
  }

  /**
   * Log a debug message.
   */
  debug(message: string, context?: Readonly<Record<string, unknown>>): void {
    this.write(this.createEntry(LogLevel.Debug, message, context));
  }

  /**
   * Log an info message.
   */
  info(message: string, context?: Readonly<Record<string, unknown>>): void {
    this.write(this.createEntry(LogLevel.Info, message, context));
  }

  /**
   * Log a warning.
   */
  warn(message: string, context?: Readonly<Record<string, unknown>>): void {
    this.write(this.createEntry(LogLevel.Warn, message, context));
  }

  /**
   * Log an error.
   */
  error(message: string, error?: Error, context?: Readonly<Record<string, unknown>>): void {
    this.write(this.createEntry(LogLevel.Error, message, context, error));
  }

  /**
   * Create a child logger with additional context.
   */
  withContext(additionalContext: Readonly<Record<string, unknown>>): Logger {
    const child = Object.create(Logger.prototype);
    Object.assign(child, this);

    // Override log methods to merge context
    const originalDebug = child.debug.bind(child);
    const originalInfo = child.info.bind(child);
    const originalWarn = child.warn.bind(child);
    const originalError = child.error.bind(child);

    child.debug = (message: string, context?: Readonly<Record<string, unknown>>) => {
      return originalDebug(message, { ...additionalContext, ...context });
    };

    child.info = (message: string, context?: Readonly<Record<string, unknown>>) => {
      return originalInfo(message, { ...additionalContext, ...context });
    };

    child.warn = (message: string, context?: Readonly<Record<string, unknown>>) => {
      return originalWarn(message, { ...additionalContext, ...context });
    };

    child.error = (message: string, error?: Error, context?: Readonly<Record<string, unknown>>) => {
      return originalError(message, error, { ...additionalContext, ...context });
    };

    child.withContext = (ctx: Readonly<Record<string, unknown>>) => {
      return this.withContext({ ...additionalContext, ...ctx });
    };

    return child;
  }
}

/**
 * Default logger instance.
 */
export const defaultLogger = new Logger();

/**
 * Create a logger for a specific component.
 */
export function createLogger(component: string): Logger {
  return defaultLogger.withContext({ component });
}
