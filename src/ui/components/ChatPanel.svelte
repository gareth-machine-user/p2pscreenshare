<script lang="ts">
  import { CHAT_MAX_LEN, type ChatMessage } from '../../mesh/mesh'
  import Avatar from './Avatar.svelte'
  import Badges from './Badges.svelte'
  import Icon from './Icon.svelte'

  let {
    messages,
    selfId,
    badges,
    guestName = null,
    onpickname,
    onsend,
  }: {
    messages: ChatMessage[]
    selfId: string
    /** Badge text per peer id (owner, presenting). */
    badges: (id: string) => string[]
    /** This peer's placeholder name while it hasn't picked one. */
    guestName?: string | null
    onpickname?: () => void
    /** Returns false when rate limited. */
    onsend: (text: string) => boolean
  } = $props()

  let draft = $state('')
  let limited = $state(false)
  let list: HTMLDivElement | undefined = $state()

  $effect(() => {
    void messages.length
    if (list) list.scrollTop = list.scrollHeight
  })

  function send(e: SubmitEvent) {
    e.preventDefault()
    if (!draft.trim()) return
    if (onsend(draft)) {
      draft = ''
      limited = false
    } else {
      limited = true
    }
  }

  const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
</script>

{#if messages.length}
  <div class="chat-list" bind:this={list} data-testid="chat-list">
    {#each messages as m (m.id)}
      {@const who = m.name || m.from.slice(0, 6)}
      <div class="chat-msg" class:mine={m.from === selfId} data-testid="chat-msg">
        <Avatar id={m.from} name={who} />
        <div class="chat-body">
          <div class="chat-meta">
            <b>{who}</b>
            <Badges list={badges(m.from)} />
            <span class="chat-time">{time(m.at)}</span>
          </div>
          <div class="chat-text">{m.text}</div>
        </div>
      </div>
    {/each}
  </div>
{:else}
  <div class="chat-empty" data-testid="chat-list">
    <Icon name="chat" size={28} />
    <span>No messages yet. Say hi when people arrive.</span>
  </div>
{/if}
<div class="chat-foot">
  {#if guestName}
    <p class="hint">You're <b>{guestName}</b>. <button class="link" data-testid="pick-name" onclick={onpickname}>Pick a name</button></p>
  {/if}
  <form class="chat-form" onsubmit={send}>
    <label class="sr-only" for="chat-input">Message</label>
    <input id="chat-input" data-testid="chat-input" placeholder="Message the lobby" maxlength={CHAT_MAX_LEN} autocomplete="off" bind:value={draft} />
    <button type="submit" data-testid="chat-send" aria-label="Send"><Icon name="send" /></button>
  </form>
  {#if limited}<p class="hint">Slow down a little.</p>{/if}
</div>
