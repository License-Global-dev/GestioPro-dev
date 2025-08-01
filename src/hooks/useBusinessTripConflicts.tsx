
import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { format, eachDayOfInterval } from 'date-fns';
import { useCompanyHolidays } from './useCompanyHolidays';

export const useBusinessTripConflicts = (selectedEmployees: string[]) => {
  const [conflictDates, setConflictDates] = useState<Date[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { isHoliday, holidays } = useCompanyHolidays();
  
  // Debug: verifica se le festività sono caricate
  console.log('🔍 Debug: Festività caricate dal database:', holidays?.length || 0);
  if (holidays && holidays.length > 0) {
    console.log('🔍 Debug: Prime 5 festività:', holidays.slice(0, 5).map(h => ({ name: h.name, date: h.date, is_recurring: h.is_recurring })));
  }

  const calculateConflicts = useCallback(async (userIds: string[]) => {
    setIsLoading(true);
    setError(null);
    
    console.log('🔍 Calcolo conflitti RIGOROSO per dipendenti:', userIds);
    console.log('🔍 Hook useCompanyHolidays - holidays disponibili:', holidays?.length || 0);
    console.log('🔍 Hook useCompanyHolidays - isHoliday function:', typeof isHoliday);
    
    const conflictDates = new Set<string>();
    const today = new Date();
    
    try {
      // 1. CONTROLLO FESTIVITÀ GLOBALI (sempre attivo, anche senza dipendenti selezionati)
      const currentYear = today.getFullYear();
      const startOfYear = new Date(currentYear, 0, 1);
      const endOfYear = new Date(currentYear, 11, 31);
      const allDaysInYear = eachDayOfInterval({ start: startOfYear, end: endOfYear });
      
      console.log('🔍 Controllo festività per tutto l\'anno:', currentYear);
      console.log('🔍 Date da controllare:', allDaysInYear.length);
      
      allDaysInYear.forEach(date => {
        const isHolidayResult = isHoliday(date);
        if (isHolidayResult) {
          const dateStr = format(date, 'yyyy-MM-dd');
          conflictDates.add(dateStr);
          console.log('🎉 Festività trovata:', dateStr);
        }
      });
      
      // Debug: verifica se le festività sono caricate
      console.log('🔍 Debug: Verifica festività per date specifiche');
      const testDates = [
        new Date('2025-01-01'), // Capodanno
        new Date('2025-12-25'), // Natale
        new Date('2025-05-01'), // 1° Maggio
        new Date('2025-08-15'), // Ferragosto
      ];
      
      testDates.forEach(date => {
        const isHolidayResult = isHoliday(date);
        console.log(`🔍 Data ${format(date, 'yyyy-MM-dd')} è festività:`, isHolidayResult);
      });

      console.log('🎉 Numero totale di festività trovate:', Array.from(conflictDates).length);

      // Se non ci sono dipendenti selezionati, mostra solo le festività
      if (!userIds || userIds.length === 0) {
        const conflictDateObjects = Array.from(conflictDates).map(dateStr => new Date(dateStr));
        console.log('🎉 Date di conflitto (solo festività):', conflictDateObjects.map(d => format(d, 'yyyy-MM-dd')));
        setConflictDates(conflictDateObjects);
        setIsLoading(false);
        return;
      }

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

        // 3. CONTROLLO TUTTI I CONGEDI APPROVATI (FERIE, PERMESSI)
        const { data: approvedLeaveRequests } = await supabase
          .from('leave_requests')
          .select('type, date_from, date_to, day')
          .eq('user_id', userId)
          .eq('status', 'approved');

        if (approvedLeaveRequests) {
          for (const leave of approvedLeaveRequests) {
            if (leave.type === 'ferie' && leave.date_from && leave.date_to) {
              const startDate = new Date(leave.date_from);
              const endDate = new Date(leave.date_to);
              const allDays = eachDayOfInterval({ start: startDate, end: endDate });
              
              allDays.forEach(day => {
                conflictDates.add(format(day, 'yyyy-MM-dd'));
              });
            }
            
            if (leave.type === 'permesso' && leave.day) {
              conflictDates.add(format(new Date(leave.day), 'yyyy-MM-dd'));
            }
          }
        }

        // 4. CONTROLLO MALATTIE (dalla tabella dedicata)
        const { data: sickLeaves } = await supabase
          .from('sick_leaves')
          .select('start_date, end_date')
          .eq('user_id', userId);

        if (sickLeaves) {
          for (const sickLeave of sickLeaves) {
            const startDate = new Date(sickLeave.start_date);
            const endDate = new Date(sickLeave.end_date);
            const allDays = eachDayOfInterval({ start: startDate, end: endDate });
            
            allDays.forEach(day => {
              conflictDates.add(format(day, 'yyyy-MM-dd'));
            });
          }
        }

        // 5. CONTROLLO PRESENZE ESISTENTI (NUOVO)
        const { data: existingAttendances } = await supabase
          .from('unified_attendances')
          .select('date')
          .eq('user_id', userId)
          .not('check_in_time', 'is', null)
          .eq('is_business_trip', false)
          .eq('is_sick_leave', false)
          .lte('date', format(today, 'yyyy-MM-dd'));

        if (existingAttendances) {
          for (const attendance of existingAttendances) {
            conflictDates.add(format(new Date(attendance.date), 'yyyy-MM-dd'));
          }
        }
      }

      // Converti le date string in oggetti Date
      const conflictDateObjects = Array.from(conflictDates).map(dateStr => new Date(dateStr));
      
      console.log('📅 Date con conflitti CRITICI trovate:', conflictDateObjects.length);
      setConflictDates(conflictDateObjects);
      
    } catch (error) {
      console.error('❌ Errore nel calcolo conflitti per dipendenti:', error);
      setError('Errore nel calcolo dei conflitti');
      setConflictDates([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      calculateConflicts(selectedEmployees);
    }, 300); // Debounce di 300ms

    return () => clearTimeout(timeoutId);
  }, [selectedEmployees, calculateConflicts]);

  const isDateDisabled = useCallback((date: Date) => {
    const dateStr = format(date, 'yyyy-MM-dd');
    const isDisabled = conflictDates.some(conflictDate => 
      dateStr === format(conflictDate, 'yyyy-MM-dd')
    );
    
    console.log(`🔍 isDateDisabled chiamata per ${dateStr}:`, isDisabled);
    console.log(`🔍 Date di conflitto disponibili:`, conflictDates.map(d => format(d, 'yyyy-MM-dd')));
    
    if (isDisabled) {
      console.log('🚫 Data disabilitata:', dateStr);
    }
    
    return isDisabled;
  }, [conflictDates]);

  return {
    conflictDates,
    isLoading,
    error,
    isDateDisabled
  };
};
