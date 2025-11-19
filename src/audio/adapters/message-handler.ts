// src/audio/adapters/message-handler.ts
/**
 * Request/Response message handler for worklet communication.
 *
 * This replaces the fire-and-forget message pattern with:
 * - Promise-based async operations
 * - Automatic message ID generation and tracking
 * - Timeout handling
 * - Error recovery
 * - Operation queuing during initialization
 */

import type { WorkletMessage, OperationResponse } from '../types/worklet-messages';
import { WorkletMessageValidator } from '../types/worklet-messages';

// ============================================================================
// Types
// ============================================================================

/** Pending request waiting for response */
interface PendingRequest {
  messageId: string;
  resolve: (data?: unknown) => void;
  reject: (error: Error) => void;
  timeout: number; // setTimeout handle
  timestamp: number;
  type: string;
}

/** Configuration for message handler */
export interface MessageHandlerConfig {
  /** Default timeout in ms for operations (default: 5000) */
  defaultTimeout?: number;
  /** Maximum queued messages during initialization (default: 100) */
  maxQueueSize?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
}

/** Queue item for operations during initialization */
interface QueuedOperation {
  message: WorkletMessage;
  resolve: (data?: unknown) => void;
  reject: (error: Error) => void;
}

// ============================================================================
// WorkletMessageHandler Class
// ============================================================================

export class WorkletMessageHandler {
  private pendingRequests = new Map<string, PendingRequest>();
  private workletPort: MessagePort | null = null;
  private initialized = false;
  private messageQueue: QueuedOperation[] = [];

  // Configuration
  private readonly defaultTimeout: number;
  private readonly maxQueueSize: number;
  private readonly debug: boolean;

  constructor(config: MessageHandlerConfig = {}) {
    this.defaultTimeout = config.defaultTimeout ?? 5000;
    this.maxQueueSize = config.maxQueueSize ?? 100;
    this.debug = config.debug ?? false;
  }

  // ========================================================================
  // Setup
  // ========================================================================

  /**
   * Attaches to a worklet's message port.
   */
  attachToWorklet(workletNode: AudioWorkletNode): void {
    if (this.workletPort) {
      throw new Error('Already attached to a worklet');
    }

    this.workletPort = workletNode.port;
    this.workletPort.onmessage = this.handleIncomingMessage.bind(this);

    this.log('Attached to worklet port');
  }

  /**
   * Marks the worklet as initialized and processes queued messages.
   */
  markInitialized(): void {
    if (this.initialized) {
      this.log('Already initialized, ignoring');
      return;
    }

    this.initialized = true;
    this.log(`Initialized. Processing ${this.messageQueue.length} queued messages`);

    // Process all queued operations
    const queue = this.messageQueue;
    this.messageQueue = [];

    for (const op of queue) {
      this.sendMessageInternal(op.message)
        .then(op.resolve)
        .catch(op.reject);
    }
  }

  /**
   * Checks if the handler is initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  // ========================================================================
  // Message Sending
  // ========================================================================

  /**
   * Sends a message to the worklet and returns a promise for the response.
   * If not initialized, queues the message until initialization completes.
   *
   * @param message - Message to send
   * @param timeout - Optional timeout in ms (uses default if not specified)
   * @returns Promise that resolves with response data or rejects on error/timeout
   */
  async sendMessage<T = unknown>(
    message: WorkletMessage,
    timeout?: number
  ): Promise<T> {
    // Validate message
    const validationError = WorkletMessageValidator.validate(message);
    if (validationError) {
      throw new Error(`Invalid message: ${validationError}`);
    }

    // Queue if not initialized
    if (!this.initialized) {
      return this.queueMessage(message);
    }

    return this.sendMessageInternal<T>(message, timeout);
  }

  /**
   * Sends a fire-and-forget message (no response expected).
   * These messages don't get queued and are sent immediately.
   */
  sendFireAndForget(message: WorkletMessage): void {
    if (!this.workletPort) {
      throw new Error('Not attached to worklet');
    }

    const validationError = WorkletMessageValidator.validate(message);
    if (validationError) {
      console.warn(`[MessageHandler] Invalid fire-and-forget message: ${validationError}`);
      return;
    }

    this.log(`Sending fire-and-forget: ${message.type}`);
    this.workletPort.postMessage(message);
  }

  /**
   * Internal: Actually sends the message and sets up response handling.
   */
  private sendMessageInternal<T = unknown>(
    message: WorkletMessage,
    timeoutMs?: number
  ): Promise<T> {
    if (!this.workletPort) {
      return Promise.reject(new Error('Not attached to worklet'));
    }

    return new Promise<T>((resolve, reject) => {
      // Generate message ID if not present
      const messageId = message.messageId ?? this.generateMessageId();
      const messageWithId = { ...message, messageId };

      // Set up timeout
      const timeout = timeoutMs ?? this.defaultTimeout;
      const timeoutHandle = window.setTimeout(() => {
        this.handleTimeout(messageId);
      }, timeout);

      // Store pending request
      this.pendingRequests.set(messageId, {
        messageId,
        resolve: resolve as (data?: unknown) => void,
        reject,
        timeout: timeoutHandle,
        timestamp: Date.now(),
        type: message.type,
      });

      // Send message
      this.log(`Sending: ${message.type} (id: ${messageId})`);
      this.workletPort.postMessage(messageWithId);
    });
  }

  /**
   * Queues a message to be sent after initialization.
   */
  private queueMessage<T = unknown>(message: WorkletMessage): Promise<T> {
    if (this.messageQueue.length >= this.maxQueueSize) {
      return Promise.reject(
        new Error(`Message queue full (${this.maxQueueSize} messages). Worklet may not be initializing.`)
      );
    }

    this.log(`Queuing message: ${message.type} (queue size: ${this.messageQueue.length + 1})`);

    return new Promise<T>((resolve, reject) => {
      this.messageQueue.push({
        message,
        resolve: resolve as (data?: unknown) => void,
        reject,
      });
    });
  }

  // ========================================================================
  // Message Receiving
  // ========================================================================

  /**
   * Handles incoming messages from the worklet.
   */
  private handleIncomingMessage(event: MessageEvent): void {
    const message = event.data as WorkletMessage;

    this.log(`Received: ${message.type}`);

    // Handle operation responses
    if (message.type === 'operationResponse') {
      this.handleOperationResponse(message as OperationResponse);
      return;
    }

    // Handle ready message
    if (message.type === 'ready') {
      this.markInitialized();
      return;
    }

    // Other messages are broadcasts (not request/response) - could emit events here
    this.log(`Received broadcast message: ${message.type}`);
  }

  /**
   * Handles an operation response from the worklet.
   */
  private handleOperationResponse(response: OperationResponse): void {
    const pending = this.pendingRequests.get(response.messageId);

    if (!pending) {
      console.warn(
        `[MessageHandler] Received response for unknown message ID: ${response.messageId}`
      );
      return;
    }

    // Clear timeout
    window.clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.messageId);

    // Resolve or reject based on response
    if (response.success) {
      this.log(`Completed: ${pending.type} (took ${Date.now() - pending.timestamp}ms)`);
      pending.resolve(response.data);
    } else {
      this.log(`Failed: ${pending.type} - ${response.error}`);
      pending.reject(new Error(response.error || 'Operation failed'));
    }
  }

  /**
   * Handles request timeout.
   */
  private handleTimeout(messageId: string): void {
    const pending = this.pendingRequests.get(messageId);

    if (!pending) {
      return; // Already resolved/rejected
    }

    this.pendingRequests.delete(messageId);

    const elapsed = Date.now() - pending.timestamp;
    const error = new Error(
      `Operation timed out after ${elapsed}ms: ${pending.type} (id: ${messageId})`
    );

    this.log(`Timeout: ${pending.type} after ${elapsed}ms`);
    pending.reject(error);
  }

  // ========================================================================
  // Utilities
  // ========================================================================

  /**
   * Generates a unique message ID.
   */
  private generateMessageId(): string {
    return `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Logs a debug message if debugging is enabled.
   */
  private log(message: string): void {
    if (this.debug) {
      console.log(`[MessageHandler] ${message}`);
    }
  }

  /**
   * Gets the number of pending requests.
   */
  getPendingCount(): number {
    return this.pendingRequests.size;
  }

  /**
   * Gets the number of queued messages.
   */
  getQueuedCount(): number {
    return this.messageQueue.length;
  }

  /**
   * Clears all pending requests and queued messages.
   * Useful for cleanup or reset.
   */
  clear(): void {
    // Reject all pending requests
    for (const pending of this.pendingRequests.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(new Error('MessageHandler cleared'));
    }
    this.pendingRequests.clear();

    // Reject all queued messages
    for (const queued of this.messageQueue) {
      queued.reject(new Error('MessageHandler cleared'));
    }
    this.messageQueue = [];

    this.log('Cleared all pending and queued messages');
  }

  /**
   * Detaches from the worklet.
   */
  detach(): void {
    this.clear();

    if (this.workletPort) {
      this.workletPort.onmessage = null;
      this.workletPort = null;
    }

    this.initialized = false;
    this.log('Detached from worklet');
  }
}
