
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { useGPSValidation } from './useGPSValidation';
import { useWorkSchedules } from './useWorkSchedules';
import { useEmployeeStatus } from './useEmployeeStatus';
import { generateOperationPath, generateReadableId } from '@/utils/italianPathUtils';
import { format } from 'date-fns';

export const useAttendanceOperations = () => {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { validateLocation } = useGPSValidation();
  const { workSchedule } = useWorkSchedules();
  const { employeeStatus } = useEmployeeStatus();

  // Funzione migliorata per calcolare i ritardi con tolleranza e permessi
  const calculateLateness = (checkInTime: Date, workSchedule: any, canCheckInAfterTime?: string) => {
    if (!workSchedule || !workSchedule.start_time || !workSchedule.tolerance_minutes) {
      return { isLate: false, lateMinutes: 0 };
    }

    const dayOfWeek = checkInTime.getDay();
    const isWorkingDay = (() => {
      switch (dayOfWeek) {
        case 0: return workSchedule.sunday;
        case 1: return workSchedule.monday;
        case 2: return workSchedule.tuesday;
        case 3: return workSchedule.wednesday;
        case 4: return workSchedule.thursday;
        case 5: return workSchedule.friday;
        case 6: return workSchedule.saturday;
        default: return false;
      }
    })();

    if (!isWorkingDay) {
      return { isLate: false, lateMinutes: 0 };
    }

    let expectedStartTime: Date;
    
    // Se c'è un permesso terminato, usa l'orario di fine permesso come riferimento
    if (canCheckInAfterTime) {
      const [endHours, endMinutes] = canCheckInAfterTime.split(':').map(Number);
      expectedStartTime = new Date(checkInTime);
      expectedStartTime.setHours(endHours, endMinutes, 0, 0);
    } else {
      // Usa l'orario normale di inizio lavoro  
      const [startHours, startMinutes] = workSchedule.start_time.split(':').map(Number);
      expectedStartTime = new Date(checkInTime);
      expectedStartTime.setHours(startHours, startMinutes, 0, 0);
    }
    
    // Applica la tolleranza
    const toleranceTime = new Date(expectedStartTime);
    toleranceTime.setMinutes(toleranceTime.getMinutes() + workSchedule.tolerance_minutes);

    if (checkInTime > toleranceTime) {
      const lateMinutes = Math.floor((checkInTime.getTime() - toleranceTime.getTime()) / (1000 * 60));
      return { isLate: true, lateMinutes };
    }

    return { isLate: false, lateMinutes: 0 };
  };

  const checkInMutation = useMutation({
    mutationFn: async ({ latitude, longitude, isBusinessTrip = false, businessTripId }: { 
      latitude: number; 
      longitude: number; 
      isBusinessTrip?: boolean;
      businessTripId?: string;
    }) => {
      console.log('🔐 Inizio check-in con validazione completa:', { latitude, longitude, isBusinessTrip });

      const today = new Date().toISOString().split('T')[0];
      
      // VALIDAZIONE COMPLETA DELLO STATO DIPENDENTE
      if (!employeeStatus) {
        throw new Error('Impossibile verificare lo stato del dipendente');
      }

      // Controlla se può fare check-in
      if (!employeeStatus.canCheckIn) {
        const primaryReason = employeeStatus.blockingReasons[0] || 'Presenza non consentita';
        
        // Messaggio specifico per permessi orari terminati
        if (employeeStatus.currentStatus === 'permission_ended' && employeeStatus.canCheckInAfterTime) {
          throw new Error(`Check-in consentito dopo le ${employeeStatus.canCheckInAfterTime} (fine permesso)`);
        }
        
        throw new Error(primaryReason);
      }

      // Validazione GPS
      const gpsValidation = validateLocation(latitude, longitude, isBusinessTrip);
      if (!gpsValidation.isValid) {
        throw new Error(gpsValidation.message || 'Posizione non valida');
      }

      const now = new Date();
      const checkInTime = now.toTimeString().slice(0, 5);
      
      // Calcola ritardo considerando permessi e tolleranza
      const { isLate, lateMinutes } = calculateLateness(
        now, 
        workSchedule, 
        employeeStatus.canCheckInAfterTime
      );
      
      // Genera il path organizzativo italiano
      const operationType = isBusinessTrip ? 'viaggio_lavoro' : 'presenza_normale';
      const operationPath = await generateOperationPath(operationType, user?.id!, now);
      const readableId = generateReadableId(operationType, now, user?.id!);

      console.log('📋 Check-in con controlli completi:', {
        operationPath,
        readableId,
        operationType,
        isLate,
        lateMinutes,
        employeeStatus: employeeStatus.currentStatus
      });
      
      const { data: attendanceData, error: attendanceError } = await supabase
        .from('attendances')
        .upsert({
          user_id: user?.id,
          date: today,
          check_in_time: now.toISOString(),
          check_in_latitude: latitude,
          check_in_longitude: longitude,
          is_business_trip: isBusinessTrip,
          business_trip_id: businessTripId,
        }, {
          onConflict: 'user_id,date'
        })
        .select()
        .single();

      if (attendanceError) throw attendanceError;

      const { data: unifiedData, error: unifiedError } = await supabase
        .from('unified_attendances')
        .upsert({
          user_id: user?.id,
          date: today,
          check_in_time: checkInTime,
          is_manual: false,
          is_business_trip: isBusinessTrip,
          is_late: isLate,
          late_minutes: lateMinutes,
          notes: readableId,
          created_by: user?.id,
        }, {
          onConflict: 'user_id,date'
        })
        .select()
        .single();

      if (unifiedError) throw unifiedError;

      console.log('✅ Check-in completato con validazione completa');
      return { attendanceData, unifiedData };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['attendances'] });
      queryClient.invalidateQueries({ queryKey: ['unified-attendances'] });
      queryClient.invalidateQueries({ queryKey: ['employee-status'] });
      
      const { unifiedData } = data;
      if (unifiedData.is_late) {
        toast({
          title: "Check-in effettuato (IN RITARDO)",
          description: `Sei arrivato con ${unifiedData.late_minutes} minuti di ritardo rispetto alla tolleranza configurata`,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Check-in effettuato",
          description: "Il tuo check-in è stato registrato con successo",
        });
      }
    },
    onError: (error: any) => {
      console.error('❌ Check-in error:', error);
      toast({
        title: "Check-in non consentito",
        description: error.message || "Errore durante il check-in",
        variant: "destructive",
      });
    },
  });

  const checkOutMutation = useMutation({
    mutationFn: async ({ latitude, longitude }: { latitude: number; longitude: number }) => {
      const today = new Date().toISOString().split('T')[0];
      const now = new Date();
      const checkOutTime = now.toTimeString().slice(0, 5);
      
      console.log('🔐 Check-out con validazione');
      
      const { data: attendanceData, error: attendanceError } = await supabase
        .from('attendances')
        .update({
          check_out_time: now.toISOString(),
          check_out_latitude: latitude,
          check_out_longitude: longitude,
        })
        .eq('user_id', user?.id)
        .eq('date', today)
        .select()
        .single();

      if (attendanceError) throw attendanceError;

      const { data: unifiedData, error: unifiedError } = await supabase
        .from('unified_attendances')
        .update({
          check_out_time: checkOutTime,
        })
        .eq('user_id', user?.id)
        .eq('date', today)
        .select()
        .single();

      if (unifiedError) throw unifiedError;

      console.log('✅ Check-out completato');
      return { attendanceData, unifiedData };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attendances'] });
      queryClient.invalidateQueries({ queryKey: ['unified-attendances'] });
      queryClient.invalidateQueries({ queryKey: ['employee-status'] });
      toast({
        title: "Check-out effettuato",
        description: "Il tuo check-out è stato registrato con successo",
      });
    },
    onError: (error: any) => {
      console.error('❌ Check-out error:', error);
      toast({
        title: "Errore",
        description: "Errore durante il check-out",
        variant: "destructive",
      });
    },
  });

  return {
    checkIn: checkInMutation.mutate,
    checkOut: checkOutMutation.mutate,
    isCheckingIn: checkInMutation.isPending,
    isCheckingOut: checkOutMutation.isPending,
  };
};
