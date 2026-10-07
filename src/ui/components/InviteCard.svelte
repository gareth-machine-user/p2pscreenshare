<script lang="ts">
  import type { PublishPolicy } from '../../mesh/auth'
  import Icon from './Icon.svelte'

  let {
    link,
    isOwner,
    ownerAway,
    canShare,
    cameraOnly,
    /** Hide the share button (a request is pending, or the owner shares only). */
    showShare,
    policy,
    copied,
    oncopy,
    onshare,
    onpolicy,
  }: {
    link: string
    isOwner: boolean
    ownerAway: boolean
    canShare: boolean
    cameraOnly: boolean
    showShare: boolean
    policy: PublishPolicy
    copied: boolean
    oncopy: () => void
    onshare: () => void
    /** Opens the lobby settings (owner only). */
    onpolicy?: () => void
  } = $props()

  const what = $derived(cameraOnly ? 'camera' : 'screen')
  const POLICY: Record<PublishPolicy, string> = {
    ask: 'People who join can ask to share too.',
    open: 'Anyone who joins can share too.',
    closed: 'Only you can share.',
  }
</script>

<!-- The empty stage: get people in, then share. -->
<div class="invite" data-testid="invite-card">
  <span class="invite-icon"><Icon name={cameraOnly ? 'camera' : 'screen'} size={26} /></span>
  {#if isOwner}
    <h2>Your lobby is ready</h2>
    <p>Send this link to anyone you want in the room. They join straight away and see your {what} as soon as you share it.</p>
  {:else if ownerAway}
    <h2>The owner is away</h2>
    <p>Nobody is sharing right now. You can still chat, and invite others with this link.</p>
  {:else}
    <h2>Nobody is sharing yet</h2>
    <p>Hang tight, or invite others with this link.</p>
  {/if}
  <div class="link-field">
    <label class="sr-only" for="invite-link">Lobby link</label>
    <input id="invite-link" readonly value={link} onfocus={(e) => e.currentTarget.select()} />
    <button class="soft" onclick={oncopy}><Icon name={copied ? 'check' : 'copy'} />{copied ? 'Copied' : 'Copy link'}</button>
  </div>
  {#if showShare}
    <div class="divider">then</div>
    <button class="primary big" data-testid="stage-share" onclick={onshare}>
      <Icon name={cameraOnly ? 'camera' : 'screen'} size={18} />{canShare ? `Share your ${what}` : 'Ask to share'}
    </button>
    {#if isOwner && onpolicy}
      <p class="small">{POLICY[policy]} <button class="link" onclick={onpolicy}>Change who can share</button></p>
    {/if}
  {/if}
</div>
