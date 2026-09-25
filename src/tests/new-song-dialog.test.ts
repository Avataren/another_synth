import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import NewSongDialog from 'src/components/tracker/NewSongDialog.vue';

/**
 * plan-sid-authoring.md phase 3: the New Song dialog asks for the format. A
 * SID song's options are `createNewSidDoc`'s; what that refuses is the
 * dialog's reason, and the create button stays off while it stands.
 */

const mounted: VueWrapper[] = [];
function mountDialog() {
  const wrapper = mount(NewSongDialog, { props: { open: true }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}
afterEach(() => {
  mounted.splice(0).forEach((w) => w.unmount());
});

const created = (w: VueWrapper) => w.emitted('create') as unknown[][] | undefined;

describe('the New Song dialog', () => {
  it('makes a native song by default', async () => {
    const w = mountDialog();
    expect(w.find('[data-testid="new-song-sid-options"]').exists()).toBe(false);
    await w.find('form').trigger('submit');
    expect(created(w)).toEqual([[{ format: 'native' }]]);
  });

  it('makes a SID song with its options; the tempo follows the multispeed until set', async () => {
    const w = mountDialog();
    await w.find('[data-testid="new-song-format-sid"]').setValue(true);
    await w.find('[data-testid="new-song-chip"]').setValue('8580');
    await w.find('[data-testid="new-song-multispeed"]').setValue(2);
    expect((w.find('[data-testid="new-song-tempo"]').element as HTMLInputElement).value).toBe('12');
    expect(w.find('[data-testid="new-song-tempo-note"]').text()).toContain('F0C');
    await w.find('[data-testid="new-song-rows"]').setValue(32);
    await w.find('form').trigger('submit');
    expect(created(w)).toEqual([[{ format: 'sid', options: { chipModel: '8580', speedMultiplier: 2, tempo: 12, patternRows: 32 } }]]);

    await w.find('[data-testid="new-song-tempo"]').setValue(5);
    await w.find('[data-testid="new-song-multispeed"]').setValue(3);
    expect((w.find('[data-testid="new-song-tempo"]').element as HTMLInputElement).value).toBe('5');
  });

  it('refuses options GoatTracker cannot hold, with the true reason', async () => {
    const w = mountDialog();
    await w.find('[data-testid="new-song-format-sid"]').setValue(true);
    await w.find('[data-testid="new-song-tempo"]').setValue(2);
    expect(w.find('[data-testid="new-song-problem"]').text()).toBe(
      "Not a new SID song: the tempo is not 3-127 (GoatTracker's F command).",
    );
    expect(w.find('[data-testid="new-song-create"]').attributes('disabled')).toBeDefined();
    await w.find('form').trigger('submit');
    expect(created(w)).toBeUndefined();
    await w.find('[data-testid="new-song-multispeed"]').setValue(2);
    await w.find('[data-testid="new-song-tempo"]').setValue(4);
    expect(w.find('[data-testid="new-song-problem"]').text()).toContain('at 2x the tempo is at least 5');
    await w.find('[data-testid="new-song-tempo"]').setValue(6);
    await w.find('[data-testid="new-song-rows"]').setValue(200);
    expect(w.find('[data-testid="new-song-problem"]').text()).toBe('Not a new SID song: a pattern has 1-128 rows.');
  });

  it('closes on Escape and on Cancel', async () => {
    const w = mountDialog();
    await w.find('[data-testid="new-song-dialog"]').trigger('keydown', { key: 'Escape' });
    await w.find('[data-testid="new-song-cancel"]').trigger('click');
    expect(w.emitted('close')).toHaveLength(2);
  });
});
