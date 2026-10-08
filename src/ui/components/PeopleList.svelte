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
  import { dismissable } from '../dismiss'

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
  const closeMenu = () => (menuFor = null)
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
        <div class="person-menu" use:dismissable={menuFor === p.id ? closeMenu : null}>
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
