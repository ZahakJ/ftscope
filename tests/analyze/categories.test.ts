import { describe, expect, it } from 'vitest';
import { categorize } from '../../src/core/categories';
import { CATEGORIES } from '../../src/core/model';

const want: Record<string, string> = {
  __x64_sys_read: 'entry', x64_sys_call: 'entry', do_syscall_64: 'entry', trace_syscall_enter: 'entry', task_work_run: 'entry', exit_to_user_mode_loop: 'entry',
  kvm_steal_clock: 'irq', sched_clock_cpu: 'irq', ktime_get: 'irq', hrtimer_interrupt: 'irq', tick_sched_timer: 'irq', __sysvec_apic_timer_interrupt: 'irq', irq_exit_rcu: 'irq',
  __fput: 'fs', filp_close: 'fs', mntput: 'fs', 'dput.part.0': 'fs', vfs_read: 'fs', current_time: 'fs', locks_remove_posix: 'fs',
  submit_bio: 'block', blk_mq_submit_bio: 'block', virtqueue_add_sgs: 'block', I_BDEV: 'block', blkdev_read_iter: 'block',
  tcp_sendmsg: 'net', __skb_clone: 'net',
  __zap_vma_range: 'mm', folio_remove_rmap_ptes: 'mm', __tlb_remove_folio_pages: 'mm', obj_cgroup_charge: 'mm', 'filemap_read': 'mm', free_swap_cache: 'mm', set_pte_range: 'mm',
  _raw_spin_lock: 'sync', mutex_unlock: 'sync', __rcu_read_lock: 'sync', up_read: 'sync', down_write: 'sync',
  psi_task_change: 'sched', __schedule: 'sched', io_schedule: 'sched',
  security_inode_permission: 'other', bpf_lsm_file_permission: 'other',
};

describe('categorize', () => {
  for (const [name, cat] of Object.entries(want)) it(`${name} → ${cat}`, () => expect(CATEGORIES[categorize(name)]).toBe(cat));
});
