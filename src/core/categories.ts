// Guess a kernel function's subsystem from its name. This only colours the
// picture; nothing is computed from it, so a wrong guess costs a wrong tint.

import { CATEGORIES, type Category } from './model';

const C = Object.fromEntries(CATEGORIES.map((c, i) => [c, i])) as Record<(typeof CATEGORIES)[number], number>;

// First match wins; order from specific to general.
const RULES: [RegExp, Category][] = [
  [/^(__)?(x64|ia32|arm64|se|do)_sys_|^do_syscall|^syscall_|^entry_|^x64_sys_call|^__audit_syscall|^exc_|^asm_exc_/, C.entry],
  [/irq|^asm_sysvec|^sysvec_|^asm_common_interrupt|^common_interrupt|softirq|tasklet|hrtimer|^tick_|^timer|_timer(s)?(_|$)|^clockevents|^ktime_|^lapic|^apic_|^nmi_|^run_local_timers|^update_process_times/, C.irq],
  [/^(__)?(raw_)?(spin|read|write)_(lock|unlock|trylock)|^_raw_|^mutex_|^__mutex|^rwsem|^down_(read|write)|^up_(read|write)|^(__)?rcu_|^call_rcu|^srcu|^percpu_(down|up)|^lockref|^seqcount|^queued_spin|^osq_|^rt_mutex|^ww_mutex|^(__)?local_bh_|^preempt_(count|schedule)|^futex|^(__)?wake_up_bit|^wait_on_bit/, C.sync],
  [/^(__)?sched|^schedule|^__schedule|^pick_(next|task)|^(en|de)queue_task|^put_prev|^set_next|^update_(curr|rq|load|cfs|se|blocked|min_vruntime)|^(try_to_)?wake_up|^ttwu|^(__)?cond_resched|^finish_task_switch|^context_switch|^prepare_task_switch|^select_task_rq|^cpuacct|^psi_|^(__)?set_task_cpu|^resched_|^check_preempt|^wakeup_preempt|^load_balance|^idle_|^do_idle|^cpuidle|^cpu_startup_entry|^default_idle|^arch_cpu_idle|^nohz_|^io_schedule|^(__)?switch_to|^(prepare_to_|finish_|add_|remove_)wait|^autoremove_wake|^(__)?wake_up|^complete(_all)?$|^wait_for_completion|^eevdf|^pelt|^(__)?update_stats|^place_entity|^reweight|^throttle|^task_tick|^(de)?activate_task|^migrate_|^rebalance/, C.sched],
  [/^blk_|^__blk|^bio_|^submit_bio|^(__)?bdev|^blkdev|^blkcg|^elv_|^dd_|^bfq|^kyber|^mq_|^scsi_|^sd_|^nvme_|^ata_|^virtblk|^virtio_queue_rq|^virtqueue|^vring|^virtio|^iomap_|^mpage_|^(__)?submit_bh|^end_bio|^part_|^disk_|^wbt_|^rq_qos|^req_bio/, C.block],
  [/^tcp_|^udp_|^ip6?_|^inet6?_|^sock_|^sk_|^skb_|^__skb|^(__)?netif|^net_|^netdev|^dev_queue_xmit|^(__)?dev_hard|^napi_|^nf_|^neigh_|^arp_|^unix_|^netlink_|^__sys_(send|recv|socket|connect|accept|bind|listen)|^ipv[46]_|^eth_|^fib_|^rt6?_|^dst_|^xfrm|^qdisc|^pfifo|^fq_|^loopback/, C.net],
  [/^(__)?kmem_cache|^(__)?kmalloc|^kfree|^kvmalloc|^kvfree|^vmalloc|^vfree|^(__)?alloc_pages|^(__)?folio_|^filemap_|^page_cache|^(__)?page_|^(__)?free_pages|^(__)?get_free_pages|^handle_mm_fault|^(__)?handle_pte|^do_(anonymous|fault|wp|swap|read|cow|shared|user_addr|numa)|^(__)?do_page_fault|^(__)?mmap|^(__)?vm_|^vma_|^mm_|^(__)?mem_cgroup|^memcg|^obj_cgroup|^lru_|^(__)?lruvec|^zone_|^rmqueue|^get_page_from_freelist|^(un)?charge_|^try_charge|^(__)?mod_(node|zone|lruvec|memcg)|^(__)?slab_|^___slab|^__slab|^new_slab|^(un)?map_|^zap_|^unmap_|^tlb_|^flush_tlb|^pte_|^pmd_|^pud_|^p4d_|^pgd_|^(__)?pte_alloc|^mas_|^mt_|^mtree_|^(__)?anon_vma|^rmap|^shmem_|^swap|^readahead|^ondemand_readahead|^(__)?balance_dirty|^(__)?mark_page|^set_page|^clear_page|^copy_page|^workingset|^compact|^khugepaged|^mlock|^madvise|^brk|^do_brk|^mprotect|^(__)?get_user_pages|^gup_|^(__)?pagevec|^fault_|^lock_mm|^lock_vma|^mmap_(read|write)|^cgroup_rstat|^(__)?count_memcg|^policy_|^mpol_|^alloc_(slab|pages|anon)|^should_fail|^prep_new_page|^post_alloc|^xas?_/, C.mm],
  [/^vfs_|^ext4_|^jbd2_|^xfs_|^btrfs_|^f2fs_|^fat_|^proc_|^sysfs_|^kernfs_|^tmpfs|^ramfs|^devtmpfs|^debugfs|^tracefs|^seq_|^(__)?fget|^(__)?fdget|^fput|^(__)?fput|^(__)?d_|^dput|^dget|^(__)?lookup_|^path_|^link_path|^walk_component|^step_into|^filename_|^getname|^putname|^(__)?inode_|^iget|^iput|^(__)?mnt_|^mntput|^(do_)?(sys_)?open|^do_filp_open|^do_dentry_open|^(__)?fsnotify|^inotify|^fanotify|^locks_|^generic_(file|perform|write|fill)|^(__)?generic_file|^file_|^rw_verify|^ksys_(read|write|pread|pwrite|lseek)|^(do_)?(readv|writev)|^pipe_|^anon_pipe|^(__)?close_fd|^filp_|^fd_install|^alloc_fd|^(__)?alloc_file|^alloc_empty_file|^terminate_walk|^nd_|^pick_link|^may_open|^complete_walk|^try_to_unlazy|^legitimize|^security_file|^touch_atime|^atime_|^(__)?mark_inode_dirty|^simple_|^dcache|^(do_)?(new)?f?stat|^cp_new_stat|^vfs_(get|stat)|^(__)?fsnotify_parent|^(do_)?iter_|^copy_(to|from)_iter|^_copy_(to|from)_iter|^iov_iter|^import_|^devpts|^tty_|^n_tty|^pty_|^(__)?writeback|^wb_|^(__)?bread|^(__)?getblk|^(__)?find_get_block|^buffer_|^(__)?block_|^mb_cache|^errseq|^eventfd|^ep_|^do_epoll|^poll_|^do_(sys_)?poll|^(do_|core_sys_)?select|^fuse_|^nfs|^overlay|^ovl_|^erofs|^squashfs|^exfat|^ntfs|^9p|^v9fs|^p9_/, C.fs],
];

const cache = new Map<string, Category>();

export function categorize(name: string): Category {
  let c = cache.get(name);
  if (c === undefined) {
    c = C.other;
    // strip compiler suffixes: foo.isra.0, foo.constprop.1, foo.cold, foo.part.3
    const base = name.replace(/\.(isra|constprop|part|cold|llvm)(\.\d+)?/g, '');
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
