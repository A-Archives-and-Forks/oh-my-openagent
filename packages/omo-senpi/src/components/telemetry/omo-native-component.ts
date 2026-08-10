import type { TurnEndEvent } from "@code-yeongyu/senpi"
import { createDefaultPostHogTransport } from "@oh-my-opencode/telemetry-core"
import type {
  EventTelemetryClient,
  EventTelemetryProperties,
  TelemetryCaptureMessage,
  TelemetryTransport,
  TelemetryTransportFactory,
  TelemetryTransportOptions,
} from "@oh-my-opencode/telemetry-core"

import type { OmoSenpiComponent } from "../../extension/types"
import { createOmoNativePayloadBuffer } from "./omo-native-buffer"
import { createOmoNativeNoticeRegistration } from "./omo-native-notice"
import { createOmoNativePromptComponent } from "./omo-native-prompt"
import {
  createOmoNativeSessionComponent,
  type OmoNativeSessionOptions,
} from "./omo-native-session"
import { registerOmoNativeToolTelemetry } from "./omo-native-tools"
import { createOmoNativeTurnHandler } from "./omo-native-turns"
import {
  OMO_NATIVE_PROPERTY_ALLOWLISTS,
  getOmoNativeStateDir,
  hashSessionId,
  type OmoNativeEventName,
} from "./product-identity"

const SHARED_PROPERTY_KEYS = [
  "$process_person_profile",
  "package_version",
  "platform",
  "product_name",
  "schema_version",
] as const

type SharedState = {
  capture?: (name: OmoNativeEventName, properties: EventTelemetryProperties) => void
  sessionHash?: string
}

export type OmoNativeTelemetryComponentOptions = OmoNativeSessionOptions & {
  readonly stateDir?: string
  readonly skillsRoot?: string
}

export function createOmoNativeTelemetryComponent(options: OmoNativeTelemetryComponentOptions = {}): OmoSenpiComponent {
  const env = options.env ?? process.env
  const stateDir = options.stateDir ?? getOmoNativeStateDir(env)
  const buffer = createOmoNativePayloadBuffer({ stateDir, diagnostics: options.diagnostics })
  const state: SharedState = {}
  const client: Pick<EventTelemetryClient, "captureEvent"> = {
    captureEvent(name, properties) {
      if (isOmoNativeEventName(name)) state.capture?.(name, properties)
    },
  }
  const transportFactory = sharedTransportFactory(options.transportFactory ?? createDefaultPostHogTransport, state, buffer.onCapture)

  return {
    name: "telemetry",
    register(pi, ctx) {
      createOmoNativePromptComponent({
        client,
        hashSessionId: options.hashSessionId,
      }).register(pi, ctx)

      createOmoNativeSessionComponent({
        ...options,
        env,
        transportFactory,
      }).register(pi, ctx)

      pi.on("turn_end", (payload, eventCtx) => {
        if (!isTurnEndEvent(payload)) return
        const sessionHash = state.sessionHash ?? hashForContext(eventCtx, options.hashSessionId)
        createOmoNativeTurnHandler({
          client,
          diagnostics: options.diagnostics,
          sessionId: sessionHash,
        })(payload)
      })

      registerOmoNativeToolTelemetry(pi, {
        captureEvent: client.captureEvent,
        diagnostics: (message, details) => ctx.logger.warn(message, details),
        hashSessionId: options.hashSessionId,
        skillsRoot: options.skillsRoot,
      })

      createOmoNativeNoticeRegistration({
        diagnostics: options.diagnostics,
        env,
        isConfigEnabled: options.isConfigEnabled,
        stateDir,
      }).register(pi, ctx)
    },
  }
}

function sharedTransportFactory(
  factory: TelemetryTransportFactory,
  state: SharedState,
  onCapture: (payload: TelemetryCaptureMessage) => void,
): TelemetryTransportFactory {
  return (apiKey, transportOptions) => {
    const transport = factory(apiKey, transportOptions)
    if (!isNativeTransport(transportOptions)) return transport

    const wrapped: TelemetryTransport = {
      capture(message) {
        installCaptureFacade(state, transport, message, onCapture)
        transport.capture(message)
        onCapture(message)
      },
      flush: transport.flush === undefined ? undefined : () => transport.flush?.() ?? Promise.resolve(),
      async shutdown() {
        try {
          await transport.shutdown()
        } finally {
          if (state.capture !== undefined) {
            state.capture = undefined
            state.sessionHash = undefined
          }
        }
      },
    }
    return wrapped
  }
}

function installCaptureFacade(
  state: SharedState,
  transport: TelemetryTransport,
  template: TelemetryCaptureMessage,
  onCapture: (payload: TelemetryCaptureMessage) => void,
): void {
  const shared = projectProperties(template.properties ?? {}, SHARED_PROPERTY_KEYS)
  const sessionId = template.properties?.$session_id
  state.sessionHash = typeof sessionId === "string" ? sessionId : state.sessionHash
  state.capture = (name, properties) => {
    const payload: TelemetryCaptureMessage = {
      distinctId: template.distinctId,
      event: name,
      properties: {
        ...projectProperties(properties, OMO_NATIVE_PROPERTY_ALLOWLISTS[name]),
        ...shared,
      },
    }
    transport.capture(payload)
    onCapture(payload)
  }
}

function projectProperties(
  properties: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Record<string, string | number | boolean> {
  const projected: Record<string, string | number | boolean> = {}
  for (const key of keys) {
    const value = properties[key]
    if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
      projected[key] = typeof value === "string" ? value.slice(0, 64) : value
    }
  }
  return projected
}

function hashForContext(
  value: unknown,
  hash: ((rawId: string) => string) | undefined,
): string {
  if (isRecord(value) && isRecord(value.sessionManager)) {
    const getter = value.sessionManager.getSessionId
    if (typeof getter === "function") {
      const sessionId: unknown = getter.call(value.sessionManager)
      if (typeof sessionId === "string" && sessionId.length > 0) return (hash ?? hashSessionId)(sessionId)
    }
  }
  return (hash ?? hashSessionId)("unknown")
}

function isNativeTransport(options: TelemetryTransportOptions): boolean {
  return options.flushAt === 20 && options.flushInterval === 10_000
}

function isOmoNativeEventName(name: string): name is OmoNativeEventName {
  return Object.hasOwn(OMO_NATIVE_PROPERTY_ALLOWLISTS, name)
}

function isTurnEndEvent(value: unknown): value is TurnEndEvent {
  return isRecord(value) && value.type === "turn_end" && typeof value.turnIndex === "number" && isRecord(value.message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
