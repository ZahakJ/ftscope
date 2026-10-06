// Guess a kernel function's subsystem from its name. This only colours the
// picture; nothing is computed from it, so a wrong guess costs a wrong tint.

import { CATEGORIES, type Category } from './model';

const C = Object.fromEntries(CATEGORIES.map((c, i) => [c, i])) as Record<(typeof CATEGORIES)[number], number>;

// First match wins; order from specific to general. Names are matched with
// leading underscores and compiler suffixes stripped (`__zap_vma_range.isra.0`
// is matched as `zap_vma_range`). Security hooks (`security_*`, `bpf_lsm_*`,
// `apparmor_*`) and exec plumbing deliberately stay `other`.
const RULES: [RegExp, Category][] = [
  // syscall entry/exit and the work done on the way back to user space
  [/^(x64|ia32|arm64|se|do)_sys_|^do_syscall|^syscall_|^entry_|^x64_sys_call|^audit_syscall|^trace_syscall_|^task_work_|^exit_to_user_mode|^exc_|^asm_exc_|^switch_fpu_return|^fpregs_restore/, C.entry],
  // time keeping is driven by the timer interrupt: show it with interrupts
  [/^kvm_steal_clock|^sched_clock|^ktime_get|^hrtimer|^tick_|^timekeeping|^clocksource|^read_tsc|^native_sched_clock|^update_wall_time/, C.irq],
  [/irq|^asm_sysvec|^sysvec_|^asm_common_interrupt|^common_interrupt|softirq|tasklet|hrtimer|^tick_|^timer|_timer(s)?(_|$)|^clockevents|^ktime_|^lapic|^apic_|^nmi_|^run_local_timers|^update_process_times/, C.irq],
  [/^blk|^bio(_|$)|^submit_bio|^bdev_|^blkdev_|^I_BDEV|^blkcg|^elv_|^dd_|^bfq|^kyber|^scsi_|^sd_|^nvme_|^ata_|^virtblk|^virtqueue|^vring|^virtio|^vp_notify|^iomap_|^mpage_|^submit_bh|^end_bio|^part_|^disk_|^wbt_|^rq_qos|^req_bio/, C.block],
  [/^tcp_|^udp_|^ip6?_|^inet6?_|^sock_|^sk_|^skb_|^skb|^netif|^net_|^netdev|^dev_queue_xmit|^dev_hard|^napi_|^nf_|^neigh_|^arp_|^unix_|^netlink_|^sys_(send|recv|socket|connect|accept|bind|listen)|^ipv[46]_|^eth_|^fib_|^rt6?_|^dst_|^xfrm|^qdisc|^pfifo|^fq_|^loopback/, C.net],
  [/^kmem_cache|^kmalloc|^kfree|^kvmalloc|^kvfree|^vmalloc|^vfree|^alloc_pages|^folio_|^filemap_|^page_cache|^page_|^free_pages|^get_free_pages|^handle_mm_fault|^handle_pte|^do_(anonymous|fault|wp|swap|read|cow|shared|user_addr|numa)|^do_page_fault|^mmap|^vm_|^vma_|^mm_|^mem_cgroup|^memcg|^obj_cgroup|^lru_|^lruvec|^zone_|^rmqueue|^get_page_from_freelist|^(un)?charge_|^try_charge|^mod_(node|zone|lruvec|memcg)|^slab_|^_slab|^slab|^new_slab|^(un)?map_|^zap_|^unmap_|^tlb_|^flush_tlb|^pte_|^pmd_|^pud_|^p4d_|^pgd_|^pte_alloc|^mas_|^mt_|^mtree_|^anon_vma|^rmap|^shmem_|^swap|^readahead|^ondemand_readahead|^balance_dirty|^mark_page|^set_page|^clear_page|^copy_page|^workingset|^compact|^khugepaged|^mlock|^madvise|^brk|^do_brk|^mprotect|^get_user_pages|^gup_|^pagevec|^fault_|^lock_mm|^lock_vma|^mmap_(read|write)|^cgroup_rstat|^count_memcg|^policy_|^mpol_|^alloc_(slab|pages|anon)|^should_fail|^prep_new_page|^post_alloc|^xas?_/, C.mm],
  // whole-word memory nouns anywhere in the name: `next_uptodate_folio`, `set_pte_range`, `free_swap_cache`
  [/(^|_)(folios?|lru|lruvec|slab|kmem|vmas?|mm|tlb|ptes?|pmd|pages?|pgtables?|memcg|zap|swap|gup|kfence|anon|rmap|kmalloc|vmalloc|css_rstat)(_|$)|^unmap_|^free_|^alloc_|^check_(object_size|heap_object|stack_object)|^exit_mmap|^mmput|^mmdrop|^pcpu_alloc|^do_vmi_|^vms_|^special_mapping|^virt_addr_valid|^is_vmalloc_addr/, C.mm],
  [/^(raw_)?(spin|read|write)_(lock|unlock|trylock)|^mutex_|^mutex|^rwsem|^down_(read|write)|^up_(read|write)|^rcu_|^call_rcu|^srcu|^percpu_(down|up)|^lockref|^seqcount|^queued_spin|^osq_|^rt_mutex|^ww_mutex|^local_bh_|^preempt_(count|schedule)|^futex|^wake_up_bit|^wait_on_bit/, C.sync],
  [/(^|_)(rcu|spin|mutex|rwsem)(_|$)|^(up|down)_(read|write)/, C.sync],
  [/^sched|^schedule|^schedule|^pick_(next|task)|^(en|de)queue_task|^put_prev|^set_next|^update_(curr|rq|load|cfs|se|blocked|min_vruntime)|^(try_to_)?wake_up|^ttwu|^cond_resched|^finish_task_switch|^context_switch|^prepare_task_switch|^select_task_rq|^cpuacct|^psi_|^set_task_cpu|^resched_|^check_preempt|^wakeup_preempt|^load_balance|^idle_|^do_idle|^cpuidle|^cpu_startup_entry|^default_idle|^arch_cpu_idle|^nohz_|^io_schedule|^switch_to|^(prepare_to_|finish_|add_|remove_)wait|^autoremove_wake|^wake_up|^complete(_all)?$|^wait_for_completion|^eevdf|^pelt|^update_stats|^place_entity|^reweight|^throttle|^task_tick|^(de)?activate_task|^migrate_|^rebalance/, C.sched],
  [/^vfs_|^ext4_|^jbd2_|^xfs_|^btrfs_|^f2fs_|^fat_|^proc_|^sysfs_|^kernfs_|^tmpfs|^ramfs|^devtmpfs|^debugfs|^tracefs|^seq_|^fget|^fdget|^fput|^fput|^d_|^dput|^dget|^lookup_|^path_|^link_path|^walk_component|^step_into|^filename_|^getname|^putname|^inode_|^iget|^iput|^mnt_|^mntput|^(do_)?(sys_)?open|^do_filp_open|^do_dentry_open|^fsnotify|^inotify|^fanotify|^locks_|^generic_(file|perform|write|fill)|^generic_file|^file_|^rw_verify|^ksys_(read|write|pread|pwrite|lseek)|^(do_)?(readv|writev)|^pipe_|^anon_pipe|^close_fd|^filp_|^fd_install|^alloc_fd|^alloc_file|^alloc_empty_file|^terminate_walk|^nd_|^pick_link|^may_open|^complete_walk|^try_to_unlazy|^legitimize|^security_file|^touch_atime|^atime_|^mark_inode_dirty|^simple_|^dcache|^(do_)?(new)?f?stat|^cp_new_stat|^vfs_(get|stat)|^fsnotify_parent|^(do_)?iter_|^copy_(to|from)_iter|^_copy_(to|from)_iter|^iov_iter|^import_|^devpts|^tty_|^n_tty|^pty_|^writeback|^wb_|^bread|^getblk|^find_get_block|^buffer_|^block_|^mb_cache|^errseq|^eventfd|^ep_|^do_epoll|^poll_|^do_(sys_)?poll|^(do_|core_sys_)?select|^fuse_|^nfs|^overlay|^ovl_|^erofs|^squashfs|^exfat|^ntfs|^9p|^v9fs|^p9_/, C.fs],
  [/^fput|^filp_|^dnotify|^locks_|^mntput|^dput|^current_time|^make_vfs[ug]id|^from_k[ug]id|^iterate_dir|^filldir|^offset_readdir|^find_positive_dentry|^legitimize_|^set_root|^do_getname|^generic_permission|^may_lookup|^inode_permission|^vfs|^fsnotify|^dcache_|^dentry_|^mnt_|^path_|^file_|^verify_dirent_name|^fs_umode|^copy_splice_read|^splice_|^do_splice/, C.fs],
  [/^dequeue_entities|^arch_scale_cpu|^dl_server|^account_(system|user|process)|^tmigr_|^perf_event_task_tick/, C.sched],
];

const cache = new Map<string, Category>();

export function categorize(name: string): Category {
  let c = cache.get(name);
  if (c === undefined) {
    c = C.other;
    // strip compiler suffixes: foo.isra.0, foo.constprop.1, foo.cold, foo.part.3
    const base = name.replace(/\.(isra|constprop|part|cold|llvm)(\.\d+)?/g, '').replace(/^_+/, '');
    for (const [re, cat] of RULES) {
      if (re.test(base)) {
        c = cat;
        break;
      }
    }
    cache.set(name, c);
  }
  return c;
}
