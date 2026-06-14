import { supabase } from '@/src/config/supabaseClient';

export class AchievementEvaluatorService {
  /**
   * Securely queries milestone thresholds from the central database schema
   */
  public async evaluateDeveloperMilestones(developerId: string): Promise<Record<string, unknown> | null> {
    if (!supabase) return null;

    try {
      const { data, error } = await supabase
        .from("developers")
        .select("*")
        .eq("id", developerId)
        .single();

      if (error) throw error;
      return data;
    } catch (err) {
      return null;
    }
  }
}
