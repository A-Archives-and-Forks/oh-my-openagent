import { spawn } from "node:child_process"

export class TodoContinuityRpcClient {
  constructor({ bin, args, cwd, env }) {
    this.child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] })
    this.buffer = ""
    this.events = []
    this.pending = new Map()
    this.waiters = []
    this.sequence = 0
    this.stderr = ""
    this.child.stdout.on("data", (chunk) => this.onData(chunk))
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString()
    })
    this.exit = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        for (const waiter of this.waiters.splice(0)) {
          clearTimeout(waiter.timer)
          waiter.reject(new Error(`RPC exited before ${waiter.type} x${waiter.count}: ${code}/${signal}`))
        }
        resolve({ code, signal })
      })
    })
  }

  send(command, timeoutMs = 45_000) {
    const id = command.id ?? `qa-${++this.sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC timeout for ${command.type}: ${this.stderr.slice(-400)}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer)
          resolve(message)
        },
      })
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`)
    })
  }

  waitForEventCount(type, count, timeoutMs = 90_000) {
    if (this.events.filter((event) => event.type === type).length >= count) {
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        type,
        count,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1)
          reject(new Error(`RPC event timeout for ${type} x${count}: ${this.stderr.slice(-400)}`))
        }, timeoutMs),
      }
      this.waiters.push(waiter)
    })
  }

  async close() {
    this.child.stdin.end()
    return await this.exit
  }

  kill() {
    this.child.kill("SIGKILL")
  }

  onData(chunk) {
    this.buffer += chunk.toString()
    let newline
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line === "") continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message?.type === "response" && message.id !== undefined) {
        const pending = this.pending.get(message.id)
        if (pending) {
          this.pending.delete(message.id)
          pending.resolve(message)
        }
        continue
      }
      if (typeof message?.type !== "string") continue
      this.events.push(message)
      for (const waiter of [...this.waiters]) {
        if (waiter.type !== message.type) continue
        if (this.events.filter((event) => event.type === waiter.type).length < waiter.count) continue
        clearTimeout(waiter.timer)
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        waiter.resolve()
      }
    }
  }
}
