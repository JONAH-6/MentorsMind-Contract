/**
 * Security Alert Service
 * Handles logging and notification of security-related events
 */

export interface SecurityAlert {
  type: 'payment_amount_mismatch' | 'underpaid_transaction' | 'suspicious_payment' | 'large_unmatched_payment';
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  details: Record<string, any>;
  timestamp: Date;
}

export class SecurityAlertService {
  private alerts: SecurityAlert[] = [];
  private readonly maxStoredAlerts = 1000;

  /**
   * Log a security alert with structured data
   */
  async logAlert(alert: Omit<SecurityAlert, 'timestamp'>): Promise<void> {
    const fullAlert: SecurityAlert = {
      ...alert,
      timestamp: new Date(),
    };

    // Store in memory (in production, store in database)
    this.alerts.push(fullAlert);
    if (this.alerts.length > this.maxStoredAlerts) {
      this.alerts.shift(); // Remove oldest alert
    }

    // Log to console with appropriate level
    const logLevel = this.getLogLevel(alert.severity);
    const logMessage = `[SecurityAlert] ${alert.type.toUpperCase()}: ${alert.message}`;
    
    console[logLevel](logMessage, {
      severity: alert.severity,
      type: alert.type,
      details: alert.details,
      timestamp: fullAlert.timestamp.toISOString(),
    });

    // Send notifications for high/critical alerts
    if (alert.severity === 'high' || alert.severity === 'critical') {
      await this.sendNotification(fullAlert);
    }

    // Store in database (implement based on your DB layer)
    // await this.storeInDatabase(fullAlert);
  }

  /**
   * Get console log level based on severity
   */
  private getLogLevel(severity: SecurityAlert['severity']): 'log' | 'warn' | 'error' {
    switch (severity) {
      case 'low':
        return 'log';
      case 'medium':
        return 'warn';
      case 'high':
      case 'critical':
        return 'error';
    }
  }

  /**
   * Send notification for high-severity alerts
   */
  private async sendNotification(alert: SecurityAlert): Promise<void> {
    // TODO: Implement email/Slack/PagerDuty notifications
    console.error('[SecurityAlert] HIGH SEVERITY ALERT - Notification should be sent:', {
      type: alert.type,
      message: alert.message,
      severity: alert.severity,
    });

    // Example implementations:
    // await emailService.sendAlert({ ... });
    // await slackService.postMessage({ ... });
    // await pagerDutyService.triggerIncident({ ... });
  }

  /**
   * Get recent alerts
   */
  getRecentAlerts(limit: number = 100): SecurityAlert[] {
    return this.alerts.slice(-limit);
  }

  /**
   * Get alerts by type
   */
  getAlertsByType(type: SecurityAlert['type'], limit: number = 100): SecurityAlert[] {
    return this.alerts
      .filter(alert => alert.type === type)
      .slice(-limit);
  }

  /**
   * Get alerts by severity
   */
  getAlertsBySeverity(severity: SecurityAlert['severity'], limit: number = 100): SecurityAlert[] {
    return this.alerts
      .filter(alert => alert.severity === severity)
      .slice(-limit);
  }

  /**
   * Clear all stored alerts
   */
  clearAlerts(): void {
    this.alerts = [];
  }
}

export const securityAlertService = new SecurityAlertService();
