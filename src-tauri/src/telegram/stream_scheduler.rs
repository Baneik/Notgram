use std::{
    collections::{HashSet, VecDeque},
    sync::{Arc, Condvar, Mutex, OnceLock},
    thread,
};

const WORKERS: usize = 4;
const MAX_QUEUED: usize = 64;
const MAX_QUEUED_PER_FILE: usize = 8;
type FileKey = (u64, i32);
type Work = Box<dyn FnOnce(bool) + Send>;

struct Job {
    key: FileKey,
    epoch: u64,
    work: Work,
}

#[derive(Default)]
struct Queue {
    pending: VecDeque<Job>,
    active: HashSet<FileKey>,
}

impl Queue {
    fn push(&mut self, job: Job) -> Vec<Job> {
        let mut retired = Vec::new();
        let mut retained = VecDeque::new();
        while let Some(queued) = self.pending.pop_front() {
            if queued.key == job.key && queued.epoch < job.epoch {
                retired.push(queued);
            } else {
                retained.push_back(queued);
            }
        }
        self.pending = retained;
        if self.pending.len() >= MAX_QUEUED
            || self
                .pending
                .iter()
                .filter(|queued| queued.key == job.key)
                .count()
                >= MAX_QUEUED_PER_FILE
        {
            retired.push(job);
        } else {
            self.pending.push_back(job);
        }
        retired
    }

    fn next(&mut self) -> Option<Job> {
        let index = self
            .pending
            .iter()
            .position(|job| !self.active.contains(&job.key))?;
        let job = self.pending.remove(index)?;
        self.active.insert(job.key);
        Some(job)
    }
}

#[derive(Default)]
struct Scheduler {
    queue: Mutex<Queue>,
    changed: Condvar,
}

pub(super) fn dispatch(key: FileKey, epoch: u64, work: impl FnOnce(bool) + Send + 'static) {
    static SCHEDULER: OnceLock<Arc<Scheduler>> = OnceLock::new();
    let scheduler = SCHEDULER.get_or_init(|| {
        let scheduler = Arc::new(Scheduler::default());
        for index in 0..WORKERS {
            let scheduler = Arc::clone(&scheduler);
            thread::Builder::new()
                .name(format!("media-range-{index}"))
                .spawn(move || {
                    loop {
                        let job = {
                            let mut queue = scheduler.queue.lock().expect("media queue poisoned");
                            loop {
                                if let Some(job) = queue.next() {
                                    break job;
                                }
                                queue =
                                    scheduler.changed.wait(queue).expect("media queue poisoned");
                            }
                        };
                        let key = job.key;
                        (job.work)(false);
                        scheduler
                            .queue
                            .lock()
                            .expect("media queue poisoned")
                            .active
                            .remove(&key);
                        scheduler.changed.notify_all();
                    }
                })
                .expect("unable to start bounded media workers");
        }
        scheduler
    });
    let retired = scheduler
        .queue
        .lock()
        .expect("media queue poisoned")
        .push(Job {
            key,
            epoch,
            work: Box::new(work),
        });
    // Responses run outside the queue lock, including replaced sources and overload.
    for job in retired {
        (job.work)(true);
    }
    scheduler.changed.notify_all();
}

#[cfg(test)]
mod tests {
    use super::*;
    fn job(file: i32, epoch: u64) -> Job {
        Job {
            key: (0, file),
            epoch,
            work: Box::new(|_| {}),
        }
    }
    #[test]
    fn preserves_metadata_order_and_allows_other_files_to_run() {
        let mut queue = Queue::default();
        queue.push(job(1, 0));
        queue.push(job(1, 0));
        queue.push(job(2, 0));
        assert_eq!(queue.next().unwrap().key.1, 1);
        assert_eq!(queue.next().unwrap().key.1, 2);
        assert!(queue.next().is_none());
        queue.active.remove(&(0, 1));
        assert_eq!(queue.next().unwrap().key.1, 1);
    }
    #[test]
    fn a_new_source_retires_only_older_requests_of_the_same_file() {
        let mut queue = Queue::default();
        queue.push(job(1, 0));
        queue.push(job(2, 0));
        queue.push(job(1, 0));
        assert_eq!(queue.push(job(1, 1)).len(), 2);
        assert_eq!(queue.pending.len(), 2);
        assert_eq!(queue.pending.back().unwrap().epoch, 1);
    }
    #[test]
    fn bounds_both_file_and_global_backlogs() {
        let mut queue = Queue::default();
        for _ in 0..MAX_QUEUED_PER_FILE {
            assert!(queue.push(job(1, 0)).is_empty());
        }
        assert_eq!(queue.push(job(1, 0)).len(), 1);
        for file in 2..=(MAX_QUEUED - MAX_QUEUED_PER_FILE + 1) {
            queue.push(job(file as i32, 0));
        }
        assert_eq!(queue.pending.len(), MAX_QUEUED);
        assert_eq!(queue.push(job(100, 0)).len(), 1);
    }
}
