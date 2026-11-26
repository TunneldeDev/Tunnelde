import { loadHabitDetails } from "@/store/habitDetails";
import { HabitsSettingsView } from "./components/HabitsSettingsView";
import { resetHabits, useHabits } from "@/store/habits";
import { useNavigation } from "@/store/navigation";
export function HabitsSettings() {
  return (
    <HabitsSettingsView
      data={useHabits()}
      reset={resetHabits}
      loadDetails={loadHabitDetails}
      selectSection={(section) => useNavigation.getState().selectSettings(section)}
    />
  );
}
