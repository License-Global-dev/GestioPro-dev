
import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { format, eachDayOfInterval } from 'date-fns';
import { useCompanyHolidays } from './useCompanyHolidays';

export const useManualAttendanceConflicts = (selectedEmployees: string[]) => {
  const [conflictDates, setConflictDates] = useState<Date[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { isHoliday } = useCompanyHolidays();

  const calculateConflicts = useCallback(async (userIds: string[]) => {
    if (!userIds || userIds.length === 0) {
      setConflictDates([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);
    
    console.log('🔍 Calcolo conflitti per presenze/malattie per dipendenti:', userIds);
    
    const conflictDates = new Set<string>();
    
    try {
      // 1. CONTROLLO FESTIVITÀ GLOBALI (NUOVO)
      const today = new Date();
      const currentYear = today.getFullYear();
      const startOfYear = new Date(currentYear, 0, 1);
      const endOfYear = new Date(currentYear, 11, 31);
      const allDaysInYear = eachDayOfInterval({ start: startOfYear, end: endOfYear });
      
      allDaysInYear.forEach(date => {
        if (isHoliday(date)) {
          conflictDates.add(format(date, 'yyyy-MM-dd'));
        }
      });

      // Per ogni dipendente, verifica TUTTI i conflitti critici
      for (const userId of userIds) {
        // 2. CONTROLLO TRASFERTE APPROVATE ESISTENTI
        const { data: existingTrips } = await supabase
          .from('business_trips')
          .select('start_date, end_date')
          .eq('user_id', userId)
          .eq('status', 'approved');

        if (existingTrips) {
          for (const trip of existingTrips) {
            const startDate = new Date(trip.start_date);
            const endDate = new Date(trip.end_date);
            const allDays = eachDayOfInterval({ start: startDate, end: endDate });
            
            allDays.forEach(day => {
              conflictDates.add(format(day, 'yyyy-MM-dd'));
            });
          }
        }

        // 3. CONTROLLO SOLO FERIE APPROVATE (PERMESSI NON BLOCCANO PIÙ LE PRESENZE)
        const { data: approvedLeaveRequests } = await supabase
          .from('leave_requests')
          .select('type, date_from, date_to, day')
          .eq('user_id', userId)
          .eq('status', 'approved');

        if (approvedLeaveRequests) {
          for (const leave of approvedLeaveRequests) {
            // Solo le ferie bloccano le presenze manuali
            if (leave.type === 'ferie' && leave.date_from && leave.date_to) {
              const startDate = new Date(leave.date_from);
              const endDate = new Date(leave.date_to);
              const allDays = eachDayOfInterval({ start: startDate, end: endDate });
              
              allDays.forEach(day => {
                conflictDates.add(format(day, 'yyyy-MM-dd'));
              });
            }
            // PERMESSI RIMOSSI: non bloccano più le presenze manuali
          }
        }

        // 4. CONTROLLO MALATTIE E PRESENZE ESISTENTI (da unified_attendances)
        const { data: existingAttendances } = await supabase
          .from('unified_attendances')
          .select('date, is_sick_leave')
          .eq('user_id', userId);

        if (existingAttendances) {
          existingAttendances.forEach(attendance => {
            conflictDates.add(format(new Date(attendance.date), 'yyyy-MM-dd'));
          });
        }

        // 5. CONTROLLO PRESENZE MANUALI ESISTENTI
        const { data: manualAttendances } = await supabase
          .from('manual_attendances')
          .select('date')
          .eq('user_id', userId);

        if (manualAttendances) {
          manualAttendances.forEach(attendance => {
            conflictDates.add(format(new Date(attendance.date), 'yyyy-MM-dd'));
          });
        }
      }

      // Converti le date string in oggetti Date
      const conflictDateObjects = Array.from(conflictDates).map(dateStr => new Date(dateStr));
      
      console.log('📅 Date con conflitti trovate per presenze/malattie (incluse festività):', conflictDateObjects.length);
      setConflictDates(conflictDateObjects);
      
    } catch (error) {
      console.error('❌ Errore nel calcolo conflitti per presenze/malattie:', error);
      setError('Errore nel calcolo dei conflitti');
      setConflictDates([]);
    } finally {
      setIsLoading(false);
    }
  }, [isHoliday]);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      calculateConflicts(selectedEmployees);
    }, 300); // Debounce di 300ms

    return () => clearTimeout(timeoutId);
  }, [selectedEmployees, calculateConflicts]);

  const isDateDisabled = useCallback((date: Date) => {
    return conflictDates.some(conflictDate => 
      format(date, 'yyyy-MM-dd') === format(conflictDate, 'yyyy-MM-dd')
    );
  }, [conflictDates]);

  return {
    conflictDates,
    isLoading,
    error,
    isDateDisabled
  };
};
