import {
  scheduleEscrowRelease,
  cancelEscrowRelease,
  InMemoryEscrowReleaseQueue,
  EscrowReleaseQueue,
  SorobanReleaseService,
} from '../src/services/escrow-release-queue.service';

describe('scheduleEscrowRelease', () => {
  it('schedules release 48 hours after session completion', async () => {
    const mockQueue: EscrowReleaseQueue = {
      schedule: jest.fn(),
      cancel: jest.fn(),
    };

    const sessionCompletedAt = new Date('2024-01-01T12:00:00Z');
    
    await scheduleEscrowRelease(
      {
        escrowId: 'esc-123',
        mentorId: 'mentor-1',
        learnerId: 'learner-1',
        sessionCompletedAt,
      },
      mockQueue
    );

    expect(mockQueue.schedule).toHaveBeenCalledWith({
      escrowId: 'esc-123',
      mentorId: 'mentor-1',
      learnerId: 'learner-1',
      sessionCompletedAt,
      scheduledReleaseAt: new Date('2024-01-03T12:00:00Z'), // 48 hours later
    });
  });
});

describe('cancelEscrowRelease', () => {
  it('cancels scheduled release', async () => {
    const mockQueue: EscrowReleaseQueue = {
      schedule: jest.fn(),
      cancel: jest.fn(),
    };

    await cancelEscrowRelease('esc-123', mockQueue);

    expect(mockQueue.cancel).toHaveBeenCalledWith('esc-123');
  });
});

describe('InMemoryEscrowReleaseQueue', () => {
  let mockSorobanService: SorobanReleaseService;
  let queue: InMemoryEscrowReleaseQueue;

  beforeEach(() => {
    mockSorobanService = {
      releaseFunds: jest.fn().mockResolvedValue('tx-hash-123'),
    };
    queue = new InMemoryEscrowReleaseQueue(mockSorobanService);
  });

  it('executes release immediately if scheduled time is in the past', async () => {
    const pastDate = new Date(Date.now() - 1000);
    
    await queue.schedule({
      escrowId: '42',
      mentorId: 'mentor-1',
      learnerId: 'learner-1',
      sessionCompletedAt: new Date(),
      scheduledReleaseAt: pastDate,
    });

    // Give async execution time to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(mockSorobanService.releaseFunds).toHaveBeenCalledWith({
      escrowId: 42,
      releasedBy: 'learner-1',
    });
  });

  it('schedules release for future time', async () => {
    const futureDate = new Date(Date.now() + 1000);
    
    await queue.schedule({
      escrowId: '42',
      mentorId: 'mentor-1',
      learnerId: 'learner-1',
      sessionCompletedAt: new Date(),
      scheduledReleaseAt: futureDate,
    });

    expect(queue.getPendingCount()).toBe(1);
    expect(mockSorobanService.releaseFunds).not.toHaveBeenCalled();
  });

  it('cancels scheduled release', async () => {
    const futureDate = new Date(Date.now() + 10000);
    
    await queue.schedule({
      escrowId: '42',
      mentorId: 'mentor-1',
      learnerId: 'learner-1',
      sessionCompletedAt: new Date(),
      scheduledReleaseAt: futureDate,
    });

    expect(queue.getPendingCount()).toBe(1);

    await queue.cancel('42');

    expect(queue.getPendingCount()).toBe(0);
  });

  it('replaces existing job when scheduling same escrow again', async () => {
    const futureDate1 = new Date(Date.now() + 10000);
    const futureDate2 = new Date(Date.now() + 20000);
    
    await queue.schedule({
      escrowId: '42',
      mentorId: 'mentor-1',
      learnerId: 'learner-1',
      sessionCompletedAt: new Date(),
      scheduledReleaseAt: futureDate1,
    });

    expect(queue.getPendingCount()).toBe(1);

    await queue.schedule({
      escrowId: '42',
      mentorId: 'mentor-1',
      learnerId: 'learner-1',
      sessionCompletedAt: new Date(),
      scheduledReleaseAt: futureDate2,
    });

    expect(queue.getPendingCount()).toBe(1); // Still 1, not 2
  });
});
