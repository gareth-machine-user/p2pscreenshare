import { describe, expect, it, vi } from 'vitest'
import { enterFullscreen, exitFullscreen, fullscreenElement } from '../src/ui/fullscreen'

describe('fullscreen', () => {
  it('uses the standard API where there is one', async () => {
    const requestFullscreen = vi.fn(async () => {})
    expect(await enterFullscreen({ requestFullscreen })).toBe(true)
    expect(requestFullscreen).toHaveBeenCalledOnce()
  })

  it("uses Safari's prefixed API (older iPadOS)", async () => {
    const webkitRequestFullscreen = vi.fn()
    expect(await enterFullscreen({ webkitRequestFullscreen })).toBe(true)
    expect(webkitRequestFullscreen).toHaveBeenCalledOnce()
  })

  it('reports false with no API (an iPhone), so the stage fills the window instead', async () => {
    expect(await enterFullscreen({})).toBe(false)
  })

  it('reports false when the request is refused', async () => {
    const requestFullscreen = vi.fn(async () => {
      throw new TypeError('Permissions check failed')
    })
    expect(await enterFullscreen({ requestFullscreen })).toBe(false)
  })

  it('finds and exits the fullscreen element through either API', () => {
    const el = {} as Element
    const exit = vi.fn(async () => {})
    expect(fullscreenElement({ fullscreenElement: el, exitFullscreen: exit })).toBe(el)
    exitFullscreen({ fullscreenElement: el, exitFullscreen: exit })
    expect(exit).toHaveBeenCalledOnce()

    const webkitExitFullscreen = vi.fn()
    const safari = { fullscreenElement: null, exitFullscreen: exit, webkitFullscreenElement: el, webkitExitFullscreen }
    expect(fullscreenElement(safari)).toBe(el)
    exitFullscreen(safari)
    expect(webkitExitFullscreen).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledOnce()
  })
})
