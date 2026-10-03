import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PatchPicker, { type PatchOption } from 'src/components/PatchPicker.vue';

const patches: PatchOption[] = [
  { id: 'a', name: 'Saw Lead', bankId: 'b', bankName: 'Bank', category: 'Lead' },
  { id: 'b', name: 'Square Lead', bankId: 'b', bankName: 'Bank', category: 'Lead' },
  { id: 'c', name: 'Pulse Bass', bankId: 'b', bankName: 'Bank', category: 'Bass' },
];

function mountPicker(props: Record<string, unknown> = {}) {
  return mount(PatchPicker, {
    props: { modelValue: null, patches, ...props },
    attachTo: document.body,
    global: { stubs: { Teleport: true, 'q-icon': true } },
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  document.body.innerHTML = '';
});

describe('PatchPicker keyboard', () => {
  it('Enter in the search box picks the first result', async () => {
    const wrapper = mountPicker();
    await wrapper.find('.patch-picker-trigger').trigger('click');
    const input = wrapper.find('.search-input');
    await input.setValue('pulse');
    await input.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('select')?.[0]?.[0]).toMatchObject({ id: 'c', name: 'Pulse Bass' });
  });

  it('Enter with no matching result picks nothing', async () => {
    const wrapper = mountPicker();
    await wrapper.find('.patch-picker-trigger').trigger('click');
    const input = wrapper.find('.search-input');
    await input.setValue('zzzz');
    await input.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('select')).toBeUndefined();
  });

  it('Down moves focus into the results, and Up from the first returns to the search box', async () => {
    const wrapper = mountPicker();
    await wrapper.find('.patch-picker-trigger').trigger('click');
    const input = wrapper.find('.search-input');
    await input.setValue('lead');
    const dropdown = wrapper.find('.patch-picker-dropdown');
    await dropdown.trigger('keydown', { key: 'ArrowDown' });
    const items = wrapper.findAll('.patch-item');
    expect(items.length).toBe(2);
    expect(document.activeElement).toBe(items[0]!.element);
    await dropdown.trigger('keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]!.element);
    await dropdown.trigger('keydown', { key: 'ArrowUp' });
    await dropdown.trigger('keydown', { key: 'ArrowUp' });
    expect(document.activeElement).toBe(wrapper.find('.search-input').element);
  });
});
