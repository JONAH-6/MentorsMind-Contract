import { ZeroDowntimeMigrationManager } from '../src/utils/zero-downtime-migration';

describe('ZeroDowntimeMigrationManager', () => {
  let manager: ZeroDowntimeMigrationManager;

  beforeEach(() => {
    manager = new ZeroDowntimeMigrationManager();
  });

  it('should create an expand-contract migration plan', () => {
    const plan = manager.createExpandContractPlan('mig-1', 'Add user profile');
    
    expect(plan.id).toBe('mig-1');
    expect(plan.strategy).toBe('expand-contract');
    expect(plan.phases).toHaveLength(3);
    expect(plan.phases[0].name).toBe('expand');
    expect(plan.phases[2].name).toBe('contract');
  });

  it('should execute a plan in dry-run mode without errors', async () => {
    const plan = manager.createExpandContractPlan('mig-2', 'Test dry run');
    const consoleSpy = jest.spyOn(console, 'info').mockImplementation();
    
    await expect(manager.executePlan(plan, true)).resolves.not.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Dry Run: true'));
    
    consoleSpy.mockRestore();
  });
});
