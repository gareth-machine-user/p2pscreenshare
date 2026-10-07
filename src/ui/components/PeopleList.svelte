<script lang="ts" module>
  export interface Person {
    id: string
    name: string
    self: boolean
    badges: string[]
    /** Waiting for the owner to let them share. */
    asking: boolean
    /** Their connection, in a word or two; warn when it's poor or missing. */
    conn: { text: string; title: string; warn: boolean } | null
  }
</script>

<script lang="ts">
  import Avatar from './Avatar.svelte'
  import Badges from './Badges.svelte'
  import Icon from './Icon.svelte'

  let {
    people,
    onkick = null,
    onallow = null,
  }: {
    people: Person[]
    /** The owner may remove members. */
    onkick?: ((id: string) => void) | null
    /** The owner answers a request from here too. */
    onallow?: ((id: string) => void) | null
  } = $props()

  let menuFor = $state<string | null>(null)

  // Closes the menu on a click outside it, or Escape.
  $effect(() => {
    if (!menuFor) return
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !(e.target as Element).closest?.('.person-menu')) menuFor = null
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  })
</script>

<ul class="people" data-testid="people">
  {#each people as p (p.id)}
    <li class="person" class:asking={p.asking} data-testid="person" data-peer={p.id}>
      <Avatar id={p.id} name={p.name} />
      <div class="person-main">
        <div class="person-name">{p.name}{#if p.self}<span class="you"> (you)</span>{/if}</div>
        {#if p.badges.length || p.asking}
          <div class="person-sub">
            <Badges list={p.badges} />
            {#if p.asking}<span class="asking">Asked to share</span>{/if}
          </div>
        {/if}
      </div>
      {#if p.conn}<span class="person-conn" class:warn={p.conn.warn} title={p.conn.title}>{p.conn.text}</span>{/if}
      {#if !p.self && (onkick || (p.asking && onallow))}
        <div class="person-menu">
          <button aria-label={`Options for ${p.name}`} aria-expanded={menuFor === p.id} onclick={() => (menuFor = menuFor === p.id ? null : p.id)}>
            <Icon name="more" />
          </button>
          {#if menuFor === p.id}
            <div class="menu">
              {#if p.asking && onallow}
                <button
                  onclick={() => {
                    menuFor = null
                    onallow?.(p.id)
                  }}><Icon name="check" />Let them share</button
                >
              {/if}
              {#if onkick}
                <button
                  class="danger"
                  data-testid="people-kick"
                  onclick={() => {
                    menuFor = null
                    onkick?.(p.id)
                  }}><Icon name="close" />Remove from lobby</button
                >
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    </li>
  {/each}
</ul>
